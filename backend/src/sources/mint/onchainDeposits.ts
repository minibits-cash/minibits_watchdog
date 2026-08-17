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
 * An uncredited deposit is NEVER released to own capital on a timer.
 *
 * An earlier version did, on the grounds that operator liquidity should not sit
 * in the mint's liabilities forever. That was wrong: a deposit above the mint's
 * minimum can be minted at any later time — the quote never expires — so
 * reclassifying it unilaterally would decide, on the watchdog's own authority,
 * that the mint no longer owes it. The moment that legitimately happens is a
 * keyset phase-out, which is a mint policy event covered by the ToS and declared
 * through PROVABLY_UNSPENDABLE_ECASH, not something a timeout should infer.
 *
 * Dust is different, and it is separated by AMOUNT rather than by age: below the
 * mint's minimum receive amount the deposit is not merely unclaimed, it is
 * uncreditable, so there is nothing to wait for.
 */

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
    /**
     * Confirmed deposits below the mint's minimum receive amount, which CDK will
     * never credit. Own capital, not a liability. msat.
     */
    dust: bigint
    dustCount: number
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
    dust: 0n,
    dustCount: 0,
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

    // Dust first, and deliberately before the chain lookups: it is decided by
    // amount alone, so it needs no chain source at all and it saves a lookup on
    // every deposit that turns out to be uncreditable anyway.
    await classifyDust()

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
 * Mark confirmed deposits that fall below the mint's minimum receive amount.
 *
 * Needs no chain source — the amount is already in the wallet's own transaction
 * list — so this works on every deployment.
 *
 * Uses the total the wallet received in the transaction, which is CONSERVATIVE
 * rather than exact. CDK tests each receive individually, so a transaction paying
 * two 6,000 sat outputs to two quote addresses would be refused on both while
 * summing to 12,000 here and staying out of the dust set. Erring that way keeps
 * the deposit in unclaimed, which is the safe direction: it treats value as owed
 * rather than as equity.
 */
async function classifyDust(): Promise<void> {
    const threshold = BigInt(config.mintOnchainMinReceiveSat) * 1000n
    if (threshold <= 0n) return

    const { count } = await prisma.mintWalletTx.updateMany({
        where: {
            classification: 'PENDING',
            sentSat: 0n,
            confirmationHeight: { not: null },
            receivedSat: { gt: 0n, lt: threshold },
        },
        data: { classification: 'DUST', classifiedAt: new Date() },
    })

    if (count > 0) {
        log.info('[onchainDeposits] classified deposits as dust', {
            count,
            thresholdSat: config.mintOnchainMinReceiveSat,
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
            // Uncredited deposits are exempt from the window, matching the
            // exemption in summarise(). Without it the two disagreed: a deposit
            // older than ACTIVE_WINDOW_SEC still counted as a liability but could
            // never be classified out of that state again. A chain source
            // unreachable for a week would have left every deposit from that week
            // permanently PENDING, and therefore permanently owed, even after
            // bitcoind came back.
            OR: [{ firstObservedAt: { gte: since } }, { sentSat: 0n, creditedAt: null }],
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
        // An uncredited deposit is exempt from the window and never ages out.
        //
        // Aging it out would release it into own capital on a timer — the
        // watchdog deciding by timeout that the mint no longer owes it. On-chain
        // quotes never expire, so an above-minimum deposit can be minted at any
        // later time and remains a liability until it is. The moment that
        // legitimately stops being true is a keyset phase-out, which is mint
        // policy under the ToS and gets declared through
        // PROVABLY_UNSPENDABLE_ECASH.
        //
        // This is only bounded because DUST is separated by AMOUNT instead. The
        // deposits that would otherwise accumulate here forever are the ones
        // below `min_receive_amount_sat`, and those are uncreditable rather than
        // merely unclaimed — classifyDust() moves them to own capital on sight.
        where: {
            OR: [{ firstObservedAt: { gte: since } }, { sentSat: 0n, creditedAt: null }],
        },
        orderBy: { firstObservedAt: 'desc' },
    })

    let awaitingCredit = 0n
    let awaitingCreditCount = 0
    let unattributed = 0n
    let unattributedCount = 0
    let dust = 0n
    let dustCount = 0
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

        // Below the mint's minimum receive amount, so CDK will never credit it.
        // Not a liability at all — the mint owes ecash to nobody for it — and
        // therefore own capital from the moment it confirms rather than something
        // held in unclaimed waiting for an event that cannot occur.
        //
        // Reported through `dust` so remainingDelta can subtract it as explained.
        // That also makes a wrong MINT_ONCHAIN_MIN_RECEIVE_SAT self-correcting:
        // this is a LIVE set, so a deposit CDK does credit leaves it (creditedAt
        // is set, and the `continue` above takes it out) at the same moment it
        // enters `unclaimed`, and the two cancel.
        if (r.classification === 'DUST') {
            dust += r.receivedSat
            dustCount++
            continue
        }

        // PENDING — not classifiable yet. Held as owed indefinitely rather than
        // released on a timer, for the reason given on the query above.
        unclassified += r.receivedSat
        unclassifiedCount++
        awaitingCredit += r.receivedSat
        awaitingCreditCount++
    }

    return {
        awaitingCredit,
        awaitingCreditCount,
        unattributed,
        unattributedCount,
        dust,
        dustCount,
        unclassified,
        unclassifiedCount,
        movements,
        uncredited,
        error: null,
    }
}
