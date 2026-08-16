import prisma from '../../utils/prismaClient'
import { config } from '../../config'
import { log } from '../../services/logService'
import { getMintPool } from './mintClient'
import {
    QUOTE_BY_ADDRESS,
    PAYMENTS_BOOKED_BY_TXID,
    PAYMENTS_BOOKED_BY_TXID_PORTABLE,
    DB_COLLATION,
} from './mintQueries'
import { listWalletTransactions, MintWalletTx } from './mintRpcClient'
import { txDetails } from '../chain/bitcoinRpcClient'

/**
 * Classifies movements of the mint's BDK wallet, and measures the one quantity
 * the reconciliation identity was missing: on-chain deposits that have confirmed
 * in the wallet but which CDK has not yet booked.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 *
 * Under the WALLET basis, an incoming deposit becomes an ASSET the moment BDK
 * confirms it. The matching LIABILITY — the ecash the mint now owes — only
 * appears when CDK writes `amount_paid`, which lagged by 15 minutes on
 * 2026-08-16. A drift window starting inside that lag has the deposit already in
 * reserves at its start and then watches ecash be issued against it: assets flat,
 * liabilities +420,000. That produced a CRITICAL six hours after the fact, and
 * with deposits over the threshold arriving roughly daily it would have recurred
 * daily.
 *
 * Counting a confirmed deposit as unclaimed from the moment it confirms closes
 * the identity at every step of the lifecycle:
 *
 *   deposit confirms   reserves +X, awaiting +X               → remaining 0
 *   CDK books it       awaiting −X, unclaimed +X              → remaining 0
 *   ecash issued       unclaimed −X, ecash issued +X, cap −X  → remaining 0
 *
 * A genuine unbooked outflow still shows as −X, because nothing on the liability
 * side moves with it. That is the whole point of the wallet basis and it is
 * preserved.
 */

/**
 * Classification is only attempted for confirmed transactions, so an unconfirmed
 * one is not an error — it simply has no block to be looked up in yet, and its
 * value is not in `trusted_spendable` either. Retries are bounded so a
 * permanently unresolvable transaction cannot burn a chain lookup every tick.
 */
const MAX_CLASSIFY_ATTEMPTS = 12

/**
 * How long an unclassifiable deposit is still assumed to be a mint payment.
 *
 * Only reached when there is NO chain source — with bitcoind configured, a
 * deposit is classified from its own output addresses on the first tick after it
 * confirms and this bound is never consulted.
 *
 * Without one, the fallback is to assume the deposit is a mint payment, because
 * that is the conservative direction: it counts value as owed rather than as
 * equity, and understating own capital cannot produce a false shortfall alert.
 * The bound exists only so operator liquidity does not sit in the mint's
 * liabilities indefinitely, and crossing it steps own capital UP, which no drift
 * rule can fire on.
 *
 * 24 hours, not the 1 hour first written here. Measured across 18 real deposits,
 * the confirmed→booked lag ran to 55.1 minutes — a one-hour bound would have
 * released a deposit minutes before CDK booked it, and the release plus the
 * booking would then have landed in the same window as −X: precisely the false
 * CRITICAL this whole term exists to prevent. The bound has to sit well clear of
 * the real distribution, not just past its median.
 */
const INFERENCE_BOUND_SEC = 24 * 3600

/** Beyond this, a transaction is history: classified, booked, and never revisited. */
const ACTIVE_WINDOW_SEC = 7 * 86_400

/**
 * Age of a movement, measured from when it happened rather than from when the
 * watchdog first saw it.
 *
 * The distinction is the whole cold-start problem. On the first tick after
 * deployment every transaction the wallet has ever made is new *to us*, so
 * `firstObservedAt` says "just now" for all of them. Measured that way, a week
 * of long-since-credited deposits counted as awaiting credit — 2,528,048 sat of
 * fictional liability, and an event for every historical transaction.
 *
 * Confirmation time is when the value actually became an asset, which is the
 * moment the accounting cares about. Only an unconfirmed transaction has no
 * answer, and one of those is not in `trusted_spendable` and so not in the
 * arithmetic either.
 */
function ageSec(row: { confirmationTime: number | null; firstObservedAt: Date }): number {
    const now = Date.now() / 1000
    if (row.confirmationTime !== null) return now - row.confirmationTime
    return now - row.firstObservedAt.getTime() / 1000
}

/**
 * How long a movement is reported on the observation for the large-mint and
 * large-melt events.
 *
 * Kept short because these rows are persisted into every snapshot's `raw`. A
 * week of movements attached to a snapshot every five minutes would be some
 * megabytes a day of the same transactions over and over, for data that is only
 * of interest the moment it appears.
 */
export const MOVEMENT_FRESH_SEC = 900

export interface WalletMovement {
    txid: string
    receivedMsat: bigint
    sentMsat: bigint
    balanceDeltaMsat: bigint
    confirmationTime: number | null
    classification: string
    quoteId: string | null
    firstObservedAt: Date
    credited: boolean
    /** How long this deposit has been confirmed without CDK booking it. */
    uncreditedForSec: number | null
    /**
     * Never-credited deposits this outgoing transaction spent from. Non-empty
     * means a dusting attempt has just paid off — see the schema comment on
     * MintWalletTx.inputTxids.
     */
    cospentDust: string[]
}

export interface UncreditedDeposit {
    txid: string
    receivedMsat: bigint
    uncreditedForSec: number
    classification: string
    quoteId: string | null
    /** True once an outgoing transaction has spent from it. */
    cospent: boolean
}

export interface OnchainDepositReading {
    /** Confirmed in the wallet, owed ecash, not yet booked by CDK. msat. */
    awaitingCredit: bigint
    awaitingCreditCount: number
    /** Confirmed deposits with no matching mint quote — operator liquidity. msat. */
    unattributed: bigint
    unattributedCount: number
    /** Still unclassified: no chain source, or lookups failing. */
    unclassified: bigint
    unclassifiedCount: number
    /** Recent movements, for the large-mint / large-melt events. */
    movements: WalletMovement[]
    /**
     * Confirmed deposits CDK has not booked, whatever their age.
     *
     * Carried separately from `movements` because the interesting ones are by
     * definition NOT fresh — a deposit is only notable once it has stayed
     * uncredited well past the booking lag, which measured at 55 minutes across
     * 18 real deposits. The set stays small: it is the in-flight deposits plus
     * whatever dust the wallet is holding, and it ages out with the window.
     */
    uncredited: UncreditedDeposit[]
    error: string | null
}

const EMPTY: OnchainDepositReading = {
    awaitingCredit: 0n,
    awaitingCreditCount: 0,
    unattributed: 0n,
    unattributedCount: 0,
    unclassified: 0n,
    unclassifiedCount: 0,
    movements: [],
    uncredited: [],
    error: null,
}

export async function collectOnchainDeposits(): Promise<OnchainDepositReading> {
    if (!config.mintRpc.enabled) return EMPTY

    let error: string | null = null

    try {
        await cacheTransactions(await listWalletTransactions())
    } catch (e: any) {
        // NOT fatal, and specifically NOT a reason to return zero.
        //
        // The balance read and this one are separate calls, so one can fail
        // while the other succeeds — and reconciliation would then write a row
        // with the liability term zeroed, stepping remainingDelta by the whole
        // outstanding amount and reporting a shortfall that does not exist.
        //
        // Everything below reads the persisted cache, which still holds the last
        // known state. A failed poll means "no new transactions seen", which is
        // the honest reading, not "no deposits are awaiting credit".
        error = String(e?.message ?? e)
    }

    // Both work from the cache and the mint database, so they still make
    // progress when the wallet RPC is the thing that is down.
    await classifyPending()
    await refreshCreditedStatus()

    return { ...(await summarise()), error }
}

/** Upsert what the wallet reports. Amounts and confirmation can both change. */
async function cacheTransactions(txs: MintWalletTx[]): Promise<void> {
    for (const t of txs) {
        const data = {
            receivedSat: t.receivedMsat,
            sentSat: t.sentMsat,
            balanceDeltaSat: t.balanceDeltaMsat,
            confirmationHeight: t.confirmationHeight,
            confirmationTime: t.confirmationTime,
        }
        await prisma.mintWalletTx.upsert({
            where: { txid: t.txid },
            create: { txid: t.txid, ...data },
            // Classification is intentionally not touched: it is derived from the
            // block and cannot change once made.
            update: data,
        })
    }
}

/**
 * Resolve PENDING transactions to MINT_QUOTE or UNATTRIBUTED using the chain.
 *
 * Only inbound transactions are classified. An outbound one is the mint spending
 * its own funds — a melt — and carries no incoming liability to attribute, so
 * spending a chain lookup on it would buy nothing.
 */
async function classifyPending(): Promise<void> {
    if (!config.bitcoinRpc.enabled) return

    const since = new Date(Date.now() - ACTIVE_WINDOW_SEC * 1000)

    const pending = await prisma.mintWalletTx.findMany({
        where: {
            classification: 'PENDING',
            confirmationHeight: { not: null },
            classifyAttempts: { lt: MAX_CLASSIFY_ATTEMPTS },
            firstObservedAt: { gte: since },
        },
        orderBy: { firstObservedAt: 'asc' },
    })

    if (pending.length === 0) return

    for (const tx of pending) {
        try {
            const { outputs, inputTxids } = await txDetails(tx.txid, tx.confirmationHeight!)

            // Outgoing: the mint spending its own funds. Nothing to attribute on
            // the incoming side, but its INPUTS are the evidence of a dusted
            // UTXO being co-spent, so they are recorded rather than discarded.
            if (tx.sentSat !== 0n) {
                await prisma.mintWalletTx.update({
                    where: { txid: tx.txid },
                    data: {
                        classification: 'OUTGOING',
                        inputTxids,
                        classifiedAt: new Date(),
                        classifyError: null,
                        classifyAttempts: { increment: 1 },
                    },
                })
                continue
            }

            const addresses = outputs.map((o) => o.address).filter((a): a is string => a !== null)

            const quotes =
                addresses.length > 0
                    ? await getMintPool().query(QUOTE_BY_ADDRESS, [addresses])
                    : { rows: [] as any[] }

            const byAddress = new Map<string, string>(
                (quotes.rows as any[]).map((r) => [String(r.request), String(r.id)]),
            )

            const hit = outputs.find((o) => o.address && byAddress.has(o.address))

            await prisma.mintWalletTx.update({
                where: { txid: tx.txid },
                data: hit
                    ? {
                          classification: 'MINT_QUOTE',
                          quoteId: byAddress.get(hit.address!)!,
                          matchedAddress: hit.address,
                          matchedVout: hit.vout,
                          classifiedAt: new Date(),
                          classifyError: null,
                          classifyAttempts: { increment: 1 },
                      }
                    : {
                          classification: 'UNATTRIBUTED',
                          classifiedAt: new Date(),
                          classifyError: null,
                          classifyAttempts: { increment: 1 },
                      },
            })

            log.info('[onchainDeposits] classified', {
                txid: tx.txid,
                classification: hit ? 'MINT_QUOTE' : 'UNATTRIBUTED',
                quoteId: hit ? byAddress.get(hit.address!) : undefined,
                receivedSat: (tx.receivedSat / 1000n).toString(),
            })
        } catch (e: any) {
            const message = String(e?.message ?? e)
            await prisma.mintWalletTx.update({
                where: { txid: tx.txid },
                data: { classifyError: message, classifyAttempts: { increment: 1 } },
            })
            log.warn('[onchainDeposits] classification failed', { txid: tx.txid, message })
        }
    }
}

/** Byte-ordered collations, where the payment_id prefix range is valid. */
const BYTE_ORDERED = new Set(['c', 'c.utf-8', 'c.utf8', 'posix'])

let byteOrdered: boolean | undefined

async function mintDbIsByteOrdered(): Promise<boolean> {
    if (byteOrdered !== undefined) return byteOrdered

    const res = await getMintPool().query(DB_COLLATION)
    const collate = String(res.rows[0]?.lc_collate ?? '').toLowerCase()
    byteOrdered = BYTE_ORDERED.has(collate)

    log.info('[onchainDeposits] mint database collation', {
        collate,
        booking_lookup: byteOrdered ? 'indexed prefix range' : 'portable scan',
    })
    return byteOrdered
}

/**
 * Mark deposits CDK has now booked.
 *
 * Matched on the TXID, not on `txid:vout`. That matters for more than
 * convenience: without a chain source a deposit is never attributed to a
 * specific output, so an exact-vout check could only ever clear deposits that
 * had already been classified — and the unclassified ones would sit in the
 * liability side for the full inference bound even after CDK booked them,
 * double-counting the debt against a deposit that had already become unclaimed.
 * Raising that bound to 24h to accommodate the real booking lag would have made
 * it 24 hours of it.
 *
 * Applies to every uncredited inbound transaction regardless of classification,
 * so the inference path clears on the same evidence as the attributed one.
 */
async function refreshCreditedStatus(): Promise<void> {
    const open = await prisma.mintWalletTx.findMany({
        where: {
            creditedAt: null,
            sentSat: 0n,
            confirmationHeight: { not: null },
            classification: { in: ['MINT_QUOTE', 'PENDING'] },
        },
        select: { txid: true },
    })

    if (open.length === 0) return

    const txids = open.map((t) => t.txid)
    const query = (await mintDbIsByteOrdered())
        ? PAYMENTS_BOOKED_BY_TXID
        : PAYMENTS_BOOKED_BY_TXID_PORTABLE

    const booked = await getMintPool().query(query, [txids])
    const bookedSet = new Set((booked.rows as any[]).map((r) => String(r.txid)))

    const now = new Date()
    for (const txid of txids) {
        if (!bookedSet.has(txid)) continue
        await prisma.mintWalletTx.update({ where: { txid }, data: { creditedAt: now } })
        log.info('[onchainDeposits] deposit credited by the mint', { txid })
    }
}

async function summarise(): Promise<OnchainDepositReading> {
    const since = new Date(Date.now() - ACTIVE_WINDOW_SEC * 1000)

    const rows = await prisma.mintWalletTx.findMany({
        // Aged out at ACTIVE_WINDOW_SEC even when still uncredited, which is
        // safe because booking is chain-driven: measured across 18 deposits it
        // never exceeded 55 minutes, so seven days clears the distribution by
        // roughly 180×.
        //
        // The alternative — exempting uncredited deposits forever, since on-chain
        // quotes never expire — accumulates without bound. Deposits below the
        // mint's `min_receive_amount_sat` are accepted by the wallet and never
        // booked by CDK: four of them, 2,503 sat, are sitting in this wallet
        // today and account for the entire baseline gap against the ledger. Held
        // forever they would be a permanently growing phantom liability; aged
        // out they step own capital UP once, which no drift rule can fire on.
        where: { firstObservedAt: { gte: since } },
        orderBy: { firstObservedAt: 'desc' },
    })

    let awaitingCredit = 0n
    let awaitingCreditCount = 0
    let unattributed = 0n
    let unattributedCount = 0
    let unclassified = 0n
    let unclassifiedCount = 0

    const freshCutoff = Date.now() - MOVEMENT_FRESH_SEC * 1000
    const movements: WalletMovement[] = []

    // Deposits the mint accepted but never issued ecash for. Dust below the
    // configured receive minimum lands here permanently — CDK's check is on the
    // individual receive amount and ignores what the quote already holds, so a
    // small top-up to a funded quote is refused just the same.
    //
    // Their VALUE is unremarkable. Their being spent is not: that is when a
    // co-spend links the sender's dust to the rest of the wallet.
    const neverCredited = new Set(
        rows.filter((r) => r.sentSat === 0n && r.creditedAt === null).map((r) => r.txid),
    )

    // Which of those an outgoing transaction has already drawn on.
    const cospentTxids = new Set<string>()
    for (const r of rows) {
        if (r.sentSat === 0n) continue
        for (const input of r.inputTxids) {
            if (neverCredited.has(input)) cospentTxids.add(input)
        }
    }

    const uncredited: UncreditedDeposit[] = []

    for (const r of rows) {
        // BOTH conditions, and the second is the cold-start guard: on the first
        // tick every historical transaction is newly observed, and without the
        // age test each one would fire its own large-mint event.
        if (
            r.firstObservedAt.getTime() >= freshCutoff &&
            ageSec(r) <= MOVEMENT_FRESH_SEC
        ) {
            movements.push({
                txid: r.txid,
                receivedMsat: r.receivedSat,
                sentMsat: r.sentSat,
                balanceDeltaMsat: r.balanceDeltaSat,
                confirmationTime: r.confirmationTime,
                classification: r.classification,
                quoteId: r.quoteId,
                firstObservedAt: r.firstObservedAt,
                credited: r.creditedAt !== null,
                uncreditedForSec:
                    r.sentSat === 0n && r.creditedAt === null && r.confirmationTime !== null
                        ? Math.floor(ageSec(r))
                        : null,
                cospentDust: r.inputTxids.filter((t) => neverCredited.has(t)),
            })
        }

        if (r.sentSat === 0n && r.creditedAt === null && r.confirmationHeight !== null) {
            uncredited.push({
                txid: r.txid,
                receivedMsat: r.receivedSat,
                uncreditedForSec: Math.floor(ageSec(r)),
                classification: r.classification,
                quoteId: r.quoteId,
                cospent: cospentTxids.has(r.txid),
            })
        }

        // Only confirmed, pure-inbound value can be awaiting credit. `sentSat > 0`
        // means the wallet supplied inputs, so any "received" is our own change
        // from a melt — already ours, never owed to anyone.
        if (r.sentSat !== 0n) continue
        if (r.confirmationHeight === null) continue

        // Credited is credited, whichever way it was classified: the value has
        // moved into `unclaimed`, so counting it here as well would book the
        // same debt twice.
        if (r.creditedAt !== null) continue

        if (r.classification === 'MINT_QUOTE') {
            awaitingCredit += r.receivedSat
            awaitingCreditCount++
            continue
        }

        if (r.classification === 'UNATTRIBUTED') {
            unattributed += r.receivedSat
            unattributedCount++
            continue
        }

        // PENDING. Assumed owed while inside the bound, then released.
        unclassified += r.receivedSat
        unclassifiedCount++
        if (ageSec(r) <= INFERENCE_BOUND_SEC) {
            awaitingCredit += r.receivedSat
            awaitingCreditCount++
        }
    }

    return {
        awaitingCredit,
        awaitingCreditCount,
        unattributed,
        unattributedCount,
        unclassified,
        unclassifiedCount,
        movements,
        uncredited,
        error: null,
    }
}
