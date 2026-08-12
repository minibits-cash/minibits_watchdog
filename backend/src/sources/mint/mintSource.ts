import { getMintPool } from './mintClient'
import { Source } from '../types'
import { satToMsat } from '../../utils/money'
import { config } from '../../config'
import { log } from '../../services/logService'
import prisma from '../../utils/prismaClient'
import {
    KEYSET_TOTALS,
    KEYSET_BREAKDOWN,
    PROOFS_PENDING,
    MELT_QUOTES_PENDING,
    TRANSIENT_TABLES,
    TABLE_ACCESS,
    ONCHAIN_QUOTE_DISCOVERY,
    ONCHAIN_PAID_SUM,
    ONCHAIN_MELT_OUT,
    ledgerSum,
    ledgerMaxId,
} from './mintQueries'

/** Watermark keys for the on-chain accumulators. */
const ONCHAIN_DISCOVERY = 'onchain_quote_discovery'
const ONCHAIN_OUT = 'onchain_melt_out'

/**
 * Re-scan windows. Both exist for the same reason as LEDGER_OVERLAP: a row can
 * become visible slightly after the timestamp it carries, so freezing right up
 * to "now" would skip it permanently.
 */
const DISCOVERY_LAG_SEC = 3600n
const OUT_LAG_SEC = 3600n

/**
 * Ids within this distance of max(id) are re-summed every tick rather than
 * frozen. A sequence assigns ids before commit, so a lower id can commit after a
 * higher one; freezing right up to max(id) would skip such a row permanently.
 *
 * At the observed insert rate (~500/day across both ledgers) this is roughly ten
 * days of slack, and re-reading it costs a small PK range scan.
 */
const LEDGER_OVERLAP = 5000n

export interface KeysetRow {
    keysetId: string
    unit: string
    active: boolean
    inputFeePpk: number
    validFrom: number
    issued: bigint
    redeemed: bigint
    feeCollected: bigint
}

export interface MintUnitReading {
    unit: string
    issued: bigint
    redeemed: bigint
    feeCollected: bigint
    proofsPending: bigint
    proofsPendingCount: number
    pendingMeltQuotes: bigint
    pendingMeltQuotesCount: number
    meltFeeReserve: bigint
    keysetsActive: number
    keysetsTotal: number
    keysetBreakdown: KeysetRow[]
    unclaimedMintQuotes: bigint
    overIssuedMintQuotes: bigint
    /** Ledger-derived on-chain reserves. Interim until CDK exposes the BDK wallet. */
    onchainBalance: bigint
    onchainDeposits: bigint
    onchainWithdrawn: bigint
    onchainQuotes: number
    sagasInFlight: number
    meltRequestsInFlight: number
    meltRequestsInputsAmount: bigint
    raw: Record<string, unknown>
}

export interface MintReading {
    units: MintUnitReading[]
    /** Tables the role cannot read, or that we did not expect to exist. */
    unreadableTables: string[]
    knownTables: string[]
}

/**
 * Tables the collector actually reads. If any of these is unreadable, no
 * meaningful snapshot exists and the tick fails with a diagnosis rather than an
 * opaque "permission denied for table proof" from whichever query happened to
 * run first.
 */
const REQUIRED_TABLES = [
    'keyset',
    'keyset_amounts',
    'proof',
    'melt_quote',
    'melt_request',
    'saga_state',
    'mint_quote_payments',
    'mint_quote_issued',
]

export class MintPermissionError extends Error {
    constructor(public readonly tables: string[]) {
        super(
            `The watchdog role cannot SELECT ${tables.length} required table(s): ${tables.join(', ')}. ` +
                `Grants live inside the database, so dropping and recreating it destroys them. Re-run: ` +
                `GRANT SELECT ON ALL TABLES IN SCHEMA public TO <role>; ` +
                `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO <role>;`,
        )
        this.name = 'MintPermissionError'
    }
}

/**
 * A required table is absent rather than merely unreadable.
 *
 * Distinct from the permission case because the remedy is completely different:
 * this means the CDK schema moved under us, and the collector's queries need
 * updating — not a grant. Reported explicitly so it cannot be mistaken for a
 * permissions problem and "fixed" by re-granting.
 */
export class MintSchemaError extends Error {
    constructor(public readonly tables: string[]) {
        super(
            `${tables.length} required table(s) do not exist in the mint schema: ${tables.join(', ')}. ` +
                `The CDK schema has changed — the collector's queries need updating. ` +
                `Run scripts/introspect-mint-db-beekeeper.sql to see the current schema.`,
        )
        this.name = 'MintSchemaError'
    }
}

/** Tables this collector understands. An unexpected one means a CDK schema change. */
const EXPECTED_TABLES = new Set([
    'blind_signature',
    'completed_operations',
    'keyset',
    'keyset_amounts',
    'kv_store',
    'melt_quote',
    'melt_request',
    'migrations',
    'mint_quote',
    'mint_quote_issued',
    'mint_quote_payments',
    'proof',
    'saga_state',
])

export class MintSource implements Source<MintReading> {
    readonly name = 'mint'

    async collect(): Promise<MintReading> {
        const pool = getMintPool()

        // The access check runs FIRST and alone, because it reads only system
        // catalogs — which stay readable even when every table is denied.
        //
        // Bundling it with the data queries made the diagnostic depend on the
        // very thing it was meant to diagnose: one rejected query failed the
        // whole batch, so a permission problem surfaced as an opaque "permission
        // denied for table proof" with no indication of scope or cause.
        const access = await pool.query(TABLE_ACCESS)

        const unreadableTables = access.rows
            .filter((r: any) => !r.can_select)
            .map((r: any) => String(r.table_name))

        const unknownTables = access.rows
            .map((r: any) => String(r.table_name))
            .filter((t: string) => !EXPECTED_TABLES.has(t))

        // Absent and unreadable are different failures with different remedies,
        // so they are distinguished rather than collapsed into one error.
        const present = new Set(access.rows.map((r: any) => String(r.table_name)))

        const absent = REQUIRED_TABLES.filter((t) => !present.has(t))
        if (absent.length > 0) {
            throw new MintSchemaError(absent)
        }

        const denied = REQUIRED_TABLES.filter((t) => unreadableTables.includes(t))
        if (denied.length > 0) {
            throw new MintPermissionError(denied)
        }

        const [keysets, breakdown, pendingProofs, pendingMelts, transient, payments, issued] =
            await Promise.all([
                pool.query(KEYSET_TOTALS),
                pool.query(KEYSET_BREAKDOWN),
                pool.query(PROOFS_PENDING),
                pool.query(MELT_QUOTES_PENDING),
                pool.query(TRANSIENT_TABLES),
                this.ledgerTotal('mint_quote_payments'),
                this.ledgerTotal('mint_quote_issued'),
            ])

        const onchain = await this.onchainBalance()

        const keysetRows: KeysetRow[] = (breakdown.rows as any[]).map((k) => ({
            keysetId: String(k.keyset_id),
            unit: String(k.unit),
            active: Boolean(k.active),
            inputFeePpk: Number(k.input_fee_ppk ?? 0),
            validFrom: Number(k.valid_from ?? 0),
            issued: satToMsat(k.issued),
            redeemed: satToMsat(k.redeemed),
            feeCollected: satToMsat(k.fee_collected),
        }))

        // sum(payments) − sum(issued) is the paid-but-not-yet-issued balance.
        // Quotes where paid == issued contribute zero, so the difference equals
        // the sheet's "Total unclaimed" provided nothing has issued more than it
        // was paid — which is itself an integrity invariant, surfaced below.
        const netUnclaimed = payments - issued
        const unclaimed = netUnclaimed > 0n ? netUnclaimed : 0n
        const overIssued = netUnclaimed < 0n ? -netUnclaimed : 0n

        const t = transient.rows[0] ?? {}

        const byUnit = new Map<string, MintUnitReading>()

        for (const row of keysets.rows as any[]) {
            byUnit.set(row.unit, {
                unit: row.unit,
                issued: satToMsat(row.issued),
                redeemed: satToMsat(row.redeemed),
                feeCollected: satToMsat(row.fee_collected),
                proofsPending: 0n,
                proofsPendingCount: 0,
                pendingMeltQuotes: 0n,
                pendingMeltQuotesCount: 0,
                meltFeeReserve: 0n,
                keysetsActive: Number(row.keysets_active ?? 0),
                keysetsTotal: Number(row.keysets_total ?? 0),
                keysetBreakdown: keysetRows.filter((k) => k.unit === row.unit),
                // The ledger tables carry no unit column, so unclaimed is
                // attributed to the backing unit. Correct while the mint is
                // sat-only; revisit if CDK gains multi-unit quotes.
                unclaimedMintQuotes: row.unit === config.backingUnit ? satToMsat(unclaimed) : 0n,
                overIssuedMintQuotes: row.unit === config.backingUnit ? satToMsat(overIssued) : 0n,
                // Like unclaimed, the on-chain ledger carries no unit column, so
                // it is attributed to the backing unit. Correct while the mint is
                // sat-only.
                onchainBalance:
                    row.unit === config.backingUnit ? satToMsat(onchain.paid - onchain.out) : 0n,
                onchainDeposits: row.unit === config.backingUnit ? satToMsat(onchain.paid) : 0n,
                onchainWithdrawn: row.unit === config.backingUnit ? satToMsat(onchain.out) : 0n,
                onchainQuotes: row.unit === config.backingUnit ? onchain.quotes : 0,
                sagasInFlight: Number(t.sagas ?? 0),
                meltRequestsInFlight: Number(t.melt_requests ?? 0),
                meltRequestsInputsAmount: satToMsat(t.melt_request_inputs ?? 0),
                raw: {},
            })
        }

        for (const row of pendingProofs.rows as any[]) {
            const u = byUnit.get(row.unit)
            if (!u) continue
            u.proofsPending = satToMsat(row.total)
            u.proofsPendingCount = Number(row.n ?? 0)
        }

        for (const row of pendingMelts.rows as any[]) {
            const u = byUnit.get(row.unit)
            if (!u) continue
            u.pendingMeltQuotes = satToMsat(row.total)
            u.pendingMeltQuotesCount = Number(row.n ?? 0)
            u.meltFeeReserve = satToMsat(row.fee_reserve)
        }

        for (const u of byUnit.values()) {
            u.raw = {
                ledger: { payments: payments.toString(), issued: issued.toString() },
                transient: t,
                unknownTables,
                unreadableTables,
            }
        }

        if (unreadableTables.length > 0) {
            log.warn('[MintSource] tables not readable by the watchdog role', { unreadableTables })
        }
        if (unknownTables.length > 0) {
            log.warn('[MintSource] unrecognised tables — CDK schema may have changed', { unknownTables })
        }

        return {
            units: [...byUnit.values()],
            unreadableTables,
            knownTables: access.rows.map((r: any) => String(r.table_name)),
        }
    }

    /**
     * On-chain reserves from CDK's ledger. See mintQueries.ts for why this is an
     * interim measure and what it cannot detect.
     *
     * Two halves, each bounded:
     *   deposits — primary-key sum over cached on-chain quote ids
     *   outflow  — incrementally accumulated from the operations ledger
     */
    private async onchainBalance(): Promise<{
        paid: bigint
        issued: bigint
        out: bigint
        quotes: number
        melts: number
    }> {
        const pool = getMintPool()

        // ── Discover new on-chain quotes ────────────────────────────────────
        // Watermarked on created_time, which never changes once set. The window
        // is re-scanned with a lag so a quote committed slightly out of order is
        // still picked up; the unique constraint makes re-insertion a no-op.
        const mark =
            (await prisma.ledgerWatermark.findUnique({ where: { ledger: ONCHAIN_DISCOVERY } })) ??
            (await prisma.ledgerWatermark.create({ data: { ledger: ONCHAIN_DISCOVERY } }))

        const nowSec = BigInt(Math.floor(Date.now() / 1000))
        const scanFrom = mark.frozenUpToId > DISCOVERY_LAG_SEC ? mark.frozenUpToId - DISCOVERY_LAG_SEC : 0n
        const scanTo = nowSec

        const found = await pool.query(ONCHAIN_QUOTE_DISCOVERY, [
            scanFrom.toString(),
            scanTo.toString(),
        ])

        if (found.rows.length > 0) {
            await prisma.mintOnchainQuote.createMany({
                data: (found.rows as any[]).map((r) => ({
                    quoteId: String(r.id),
                    createdTime: Number(r.created_time),
                })),
                skipDuplicates: true,
            })
            log.info('[MintSource] discovered on-chain mint quotes', { count: found.rows.length })
        }

        await prisma.ledgerWatermark.update({
            where: { ledger: ONCHAIN_DISCOVERY },
            data: { frozenUpToId: scanTo },
        })

        // ── Deposits: re-read amount_paid for every known on-chain quote ────
        const known = await prisma.mintOnchainQuote.findMany({ select: { quoteId: true } })
        const ids = known.map((k) => k.quoteId)

        let paid = 0n
        let issued = 0n
        if (ids.length > 0) {
            const sums = await pool.query(ONCHAIN_PAID_SUM, [ids])
            paid = BigInt(sums.rows[0]?.paid ?? 0)
            issued = BigInt(sums.rows[0]?.issued ?? 0)
        }

        // ── Outflow: accumulate melt payouts + on-chain fees ────────────────
        const outMark =
            (await prisma.ledgerWatermark.findUnique({ where: { ledger: ONCHAIN_OUT } })) ??
            (await prisma.ledgerWatermark.create({ data: { ledger: ONCHAIN_OUT } }))

        const safeUpTo = nowSec > OUT_LAG_SEC ? nowSec - OUT_LAG_SEC : 0n
        let outTotal = outMark.frozenTotal
        let melts = 0

        if (safeUpTo > outMark.frozenUpToId) {
            const seg = await pool.query(ONCHAIN_MELT_OUT, [
                outMark.frozenUpToId.toString(),
                safeUpTo.toString(),
            ])
            outTotal += BigInt(seg.rows[0]?.out_total ?? 0)
            melts = Number(seg.rows[0]?.n ?? 0)

            await prisma.ledgerWatermark.update({
                where: { ledger: ONCHAIN_OUT },
                data: { frozenUpToId: safeUpTo, frozenTotal: outTotal },
            })
        }

        // Tail beyond the frozen boundary, re-read every tick.
        const tail = await pool.query(ONCHAIN_MELT_OUT, [safeUpTo.toString(), null])
        outTotal += BigInt(tail.rows[0]?.out_total ?? 0)
        melts += Number(tail.rows[0]?.n ?? 0)

        return { paid, issued, out: outTotal, quotes: ids.length, melts }
    }

    /**
     * Running total over an append-only ledger, using a persisted watermark so
     * per-tick cost is proportional to new rows rather than table size.
     *
     * The frozen boundary lags max(id) by LEDGER_OVERLAP; the tail beyond it is
     * recomputed every tick so rows that commit out of sequence order are still
     * counted.
     */
    private async ledgerTotal(ledger: 'mint_quote_payments' | 'mint_quote_issued'): Promise<bigint> {
        const pool = getMintPool()

        const mark =
            (await prisma.ledgerWatermark.findUnique({ where: { ledger } })) ??
            (await prisma.ledgerWatermark.create({ data: { ledger } }))

        const maxRes = await pool.query(ledgerMaxId(ledger))
        const maxId = BigInt(maxRes.rows[0]?.max_id ?? 0)

        const newFrozenUpTo = maxId > LEDGER_OVERLAP ? maxId - LEDGER_OVERLAP : 0n

        // Advance the frozen boundary by summing only the newly-safe segment.
        if (newFrozenUpTo > mark.frozenUpToId) {
            const seg = await pool.query(ledgerSum(ledger), [
                mark.frozenUpToId.toString(),
                newFrozenUpTo.toString(),
            ])
            const segTotal = BigInt(seg.rows[0]?.total ?? 0)

            await prisma.ledgerWatermark.update({
                where: { ledger },
                data: {
                    frozenUpToId: newFrozenUpTo,
                    frozenTotal: mark.frozenTotal + segTotal,
                },
            })

            mark.frozenUpToId = newFrozenUpTo
            mark.frozenTotal = mark.frozenTotal + segTotal
        }

        // Re-read the overlap tail every tick.
        const tail = await pool.query(ledgerSum(ledger), [mark.frozenUpToId.toString(), null])
        const tailTotal = BigInt(tail.rows[0]?.total ?? 0)

        return mark.frozenTotal + tailTotal
    }
}
