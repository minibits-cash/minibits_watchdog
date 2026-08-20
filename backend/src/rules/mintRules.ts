import { Rule, RuleFinding, formatSat, numParam, satParam } from './types'
import { config } from '../config'

export const mintUnreachable: Rule = {
    id: 'mint_unreachable',
    description: 'The mint database read failed',
    defaults: {
        severity: 'CRITICAL',
        forEvaluations: 2,
        clearEvaluations: 1,
        cooldownSeconds: 1800,
    },
    async evaluate({ observation }) {
        const s = observation.mintStatus
        if (s === 'OK' || s === 'SKIPPED') return []

        // The title must name the actual failure. Reporting "unreachable" for
        // every non-OK status sends the operator to check tunnels and firewalls
        // when the cause was a permission or query error against a database that
        // answered perfectly well.
        const title =
            s === 'UNREACHABLE'
                ? 'Mint database unreachable'
                : s === 'TIMEOUT'
                  ? 'Mint database read timed out'
                  : 'Mint database read failed'

        return [
            {
                dedupeKey: 'mint',
                title: `${title} (${s})`,
                detail: observation.mintError ?? undefined,
            },
        ]
    },
}

/**
 * Ecash issued against a quote that was never paid for. This is a hard
 * accounting invariant — any non-zero value means the mint has created
 * liabilities with no matching asset.
 */
export const mintOverIssued: Rule = {
    id: 'mint_over_issued',
    description: 'Mint quotes issued more than was paid',
    defaults: {
        severity: 'CRITICAL',
        forEvaluations: 1,
        clearEvaluations: 2,
        cooldownSeconds: 3600,
    },
    async evaluate({ observation }) {
        const findings: RuleFinding[] = []
        if (!observation.mints?.length) return null

        for (const m of observation.mints) {
            const over = BigInt(m.overIssuedMintQuotes)
            if (over <= 0n) continue
            findings.push({
                dedupeKey: m.unit,
                title: `Mint over-issued ${formatSat(over)} sat (${m.unit})`,
                detail: 'Ecash issued exceeds amount paid. This should never be non-zero.',
                context: { unit: m.unit, overIssuedSat: (over / 1000n).toString() },
            })
        }
        return findings
    },
}

/**
 * A CDK migration adding a table the watchdog cannot read is a silent blind
 * spot. If that migration also relocates accounting, the collector keeps
 * reporting stale figures from the old tables while appearing healthy — so the
 * schema surface is checked rather than assumed.
 */
export const mintSchemaAccess: Rule = {
    id: 'mint_schema_access',
    description: 'Mint tables unreadable, or unrecognised tables present',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 1,
        clearEvaluations: 1,
        cooldownSeconds: 86_400,
    },
    async evaluate({ observation }) {
        const findings: RuleFinding[] = []
        if (!observation.mints?.length) return null

        for (const m of observation.mints) {
            const raw = (m.raw ?? {}) as any
            const unreadable: string[] = raw.unreadableTables ?? []
            const unknown: string[] = raw.unknownTables ?? []

            if (unreadable.length > 0) {
                findings.push({
                    dedupeKey: 'unreadable',
                    title: `${unreadable.length} mint table(s) not readable`,
                    detail: unreadable.join(', '),
                    severity: 'CRITICAL',
                    context: { unreadable },
                })
            }
            if (unknown.length > 0) {
                findings.push({
                    dedupeKey: 'unknown',
                    title: `${unknown.length} unrecognised mint table(s) — schema may have changed`,
                    detail: unknown.join(', '),
                    context: { unknown },
                })
            }
            break // schema is global, not per-unit
        }
        return findings
    },
}

export const mintKeysetChange: Rule = {
    id: 'mint_keyset_change',
    description: 'Keyset count changed',
    defaults: {
        severity: 'INFO',
        forEvaluations: 1,
        clearEvaluations: 1,
        cooldownSeconds: 86_400,
        // EVENT: a rotation happened. There is no ongoing condition to clear.
        notifyOnResolve: false,
    },
    async evaluate({ observation, prisma }) {
        const findings: RuleFinding[] = []

        if (!observation.mints?.length) return null

        for (const m of observation.mints) {
            const prev = await prisma.mintSnapshot.findFirst({
                where: { unit: m.unit, observationId: { lt: observation.id } },
                orderBy: { observationId: 'desc' },
            })
            if (!prev) continue

            if (prev.keysetsTotal !== m.keysetsTotal || prev.keysetsActive !== m.keysetsActive) {
                findings.push({
                    dedupeKey: `${m.unit}:${m.keysetsTotal}:${m.keysetsActive}`,
                    title: `Keysets changed (${m.unit}): ${prev.keysetsTotal}/${prev.keysetsActive} → ${m.keysetsTotal}/${m.keysetsActive} total/active`,
                    detail: 'Verify this was an intentional rotation before trusting reserve figures.',
                })
            }
        }
        return findings
    },
}

/**
 * Proofs held in PENDING are the reliable stuck-melt signal.
 *
 * Deliberately NOT keyed on melt_quote.state='PENDING': that state accumulates
 * permanent residue spanning many months, so a rule on it would fire a large
 * batch of alerts on historical junk at first run.
 *
 * The default threshold needs calibrating against real data (SPEC.md §12 step 9)
 * — it is set above the observed baseline so it does not fire on day one, which
 * means it is currently insensitive rather than wrong.
 */
export const proofsPendingHigh: Rule = {
    id: 'mint_proofs_pending_high',
    description: 'Proofs locked in PENDING above threshold',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 3,
        clearEvaluations: 3,
        cooldownSeconds: 3600,
        params: { thresholdSat: 500_000 },
    },
    async evaluate({ observation, params }) {
        const findings: RuleFinding[] = []
        const threshold = satParam(params, 'thresholdSat', 500_000)

        if (!observation.mints?.length) return null

        for (const m of observation.mints) {
            const pending = BigInt(m.proofsPending)
            if (pending < threshold) continue
            findings.push({
                dedupeKey: m.unit,
                title: `${formatSat(pending)} sat of proofs pending (${m.proofsPendingCount} proofs, ${m.unit})`,
                detail: `Threshold ${formatSat(threshold)} sat. Sustained growth here indicates melts not completing.`,
                context: { unit: m.unit, pendingSat: (pending / 1000n).toString() },
            })
        }
        return findings
    },
}

export const meltRequestsStuck: Rule = {
    id: 'mint_melt_requests_stuck',
    description: 'Too many rows in the transient melt_request table',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 3,
        clearEvaluations: 3,
        params: { maxRows: 25 },
    },
    async evaluate({ observation, params }) {
        const findings: RuleFinding[] = []
        const max = numParam(params, 'maxRows', 25)

        if (!observation.mints?.length) return null

        for (const m of observation.mints) {
            if (m.meltRequestsInFlight <= max) continue
            findings.push({
                dedupeKey: m.unit,
                title: `${m.meltRequestsInFlight} in-flight melt_request rows (threshold ${max})`,
                detail: `${formatSat(BigInt(m.meltRequestsInputsAmount))} sat of inputs committed`,
            })
            break
        }
        return findings
    },
}

/**
 * An on-chain melt still committed past INFLIGHT_MELT_MAX_AGE_SEC.
 *
 * This is the alert half of a deliberate trade, and the LAST remaining place
 * where an age threshold changes an accounting figure. Inside the window a
 * committed melt is subtracted from the ledger estimate, because its transaction
 * has left the BDK wallet. Past it the transaction may instead have been dropped,
 * which returns the funds, so the collector stops subtracting and reports it here.
 *
 * ⚠ Its reach shrank when the WALLET basis arrived, and the distinction matters.
 * It now affects only `mintOnchainLedger` — the cross-check — because reserves
 * come from the measured wallet, which already reflects a broadcast spend exactly
 * as LND's local_balance does. So a stuck melt no longer makes the RESERVE figure
 * untrustworthy; it makes the LEDGER COMPARISON untrustworthy.
 *
 * The residue is that ageing a melt out of `inflight` steps the ledger estimate
 * up by that amount, which moves the wallet-versus-ledger gap and can therefore
 * nudge `mint_wallet_ledger_divergence`. That is a cross-check artifact, not a
 * solvency one, and this rule fires alongside it to say why.
 *
 * State-style, so it resolves: unlike a collection gap, "the melt is no longer
 * stuck" is information — it says the comparison can be trusted again.
 */
export const onchainMeltStuck: Rule = {
    id: 'mint_onchain_melt_stuck',
    description: 'On-chain melt committed but unsettled beyond the trust window',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 2,
        clearEvaluations: 2,
        cooldownSeconds: 21600,
        notifyOnResolve: true,
    },
    async evaluate({ observation }) {
        const findings: RuleFinding[] = []

        if (!observation.mints?.length) return null

        for (const m of observation.mints) {
            // Null means the collector predates this measurement — not evaluable,
            // which must not read as "none stuck".
            if (m.onchainInflightStaleCount === null) return null
            if (m.onchainInflightStaleCount === 0) continue

            const hours = Math.floor((m.onchainInflightOldestSec ?? 0) / 3600)
            findings.push({
                dedupeKey: m.unit,
                title: `${m.onchainInflightStaleCount} on-chain melt(s) unsettled for over ${hours}h`,
                detail:
                    `${formatSat(BigInt(m.onchainInflightStale ?? 0))} sat committed and no longer ` +
                    `subtracted from the CDK ledger estimate, which may therefore overstate by up ` +
                    `to that amount. Reserves are unaffected — they come from the measured wallet, ` +
                    `which already reflects the broadcast spend — so this degrades the ` +
                    `wallet-versus-ledger cross-check rather than the solvency figure. Check ` +
                    `whether the transaction confirmed, was dropped, or is still in the mempool.`,
                context: {
                    unit: m.unit,
                    staleCount: m.onchainInflightStaleCount,
                    oldestSec: m.onchainInflightOldestSec,
                },
            })
        }
        return findings
    },
}

/**
 * The BDK wallet balance could not be read, so reconciliation has no on-chain
 * asset figure and writes no row at all.
 *
 * CRITICAL because of that consequence rather than the failure itself: while
 * this fires, the reserve drift rules have nothing to evaluate and the mint is
 * effectively unmonitored for solvency. The deadman's switch does not cover it —
 * the watchdog is alive, ticking, and reporting healthily; it is simply blind on
 * one side, which is the more dangerous of the two states.
 *
 * Deliberately NOT resolved by substituting the ledger estimate. See
 * reconciliation.ts: a silent basis change steps own capital by the divergence
 * between the two and reads as drift.
 */
export const walletRpcUnreachable: Rule = {
    id: 'mint_wallet_rpc_unreachable',
    description: "The mint's BDK wallet balance could not be read over gRPC",
    defaults: {
        severity: 'CRITICAL',
        // ~15 minutes at the default cadence. A mintd restart is seconds; this
        // waits for something that is actually an outage.
        forEvaluations: 3,
        clearEvaluations: 1,
        cooldownSeconds: 3600,
        notifyOnResolve: true,
    },
    async evaluate({ observation }) {
        // Not configured at all is a deployment choice, warned about in the
        // startup banner, not an alert on every tick forever.
        if (!config.mintRpc.enabled) return null
        if (!observation.mints?.length) return null

        for (const m of observation.mints) {
            if (m.unit !== config.backingUnit) continue
            if (m.walletTrustedSpendable !== null) return []

            const raw = (m.raw ?? {}) as any
            return [
                {
                    dedupeKey: m.unit,
                    title: 'Mint BDK wallet balance unreadable',
                    detail:
                        `${String(raw?.walletRpc?.error ?? 'no error recorded')}. ` +
                        `No reconciliation row is being written while this holds, so reserve drift ` +
                        `is not being evaluated. Check cdk-mintd's management RPC listener ` +
                        `(${config.mintRpc.host}:${config.mintRpc.port}) and any tunnel in front of it.`,
                    context: { unit: m.unit, target: `${config.mintRpc.host}:${config.mintRpc.port}` },
                },
            ]
        }
        return null
    },
}

/**
 * bitcoind unreachable — the deposit classifier's only source of truth about
 * which address a payment landed on.
 *
 * CRITICAL rather than a warning, because this failure does not degrade to
 * "unknown", it degrades to "the mint owes this". A deposit that cannot be
 * attributed stays PENDING, and PENDING is summed into `depositsAwaitingCredit`
 * — a liability. So a dead chain source silently moves own capital down by the
 * full value of every deposit arriving while it is out, with nothing else on the
 * dashboard saying why. Of every external dependency the watchdog has, this is
 * the only one whose failure rewrites the accounts.
 *
 * Driven by an unconditional liveness probe rather than by classification
 * errors, so it fires on the outage itself instead of waiting for a deposit to
 * expose it.
 */
export const chainSourceUnreachable: Rule = {
    id: 'mint_chain_source_unreachable',
    description: 'bitcoind could not be reached, so on-chain deposits cannot be attributed',
    defaults: {
        severity: 'CRITICAL',
        // ~15 minutes at the default cadence: long enough to ride out a bitcoind
        // restart, short enough to catch a deposit arriving during the outage.
        forEvaluations: 3,
        clearEvaluations: 1,
        cooldownSeconds: 3600,
        notifyOnResolve: true,
    },
    async evaluate({ observation }) {
        // Unset is a deployment choice, not an alert. The classifier falls back
        // to inference, which resolves a deposit only once CDK books a payment
        // for it — so operator liquidity, which never gets a payment row, stays
        // a liability forever. That tradeoff belongs in the startup banner.
        if (!config.bitcoinRpc.enabled) return null
        if (!observation.mints?.length) return null

        for (const m of observation.mints) {
            if (m.unit !== config.backingUnit) continue

            const chain = ((m.raw ?? {}) as any)?.chainSource
            // Older rows predate the field. Absence is not evidence of failure.
            if (!chain || chain.configured === false) return null
            if (chain.ok) return []

            return [
                {
                    dedupeKey: m.unit,
                    title: 'Chain source (bitcoind) unreachable',
                    detail:
                        `${String(chain.error ?? 'no error recorded')}. ` +
                        `On-chain deposits cannot be attributed to a mint quote while this holds, ` +
                        `so any that arrive are counted as owed — depressing own capital until it ` +
                        `clears. Attempt budgets are NOT being consumed, so classification resumes ` +
                        `by itself once bitcoind answers.`,
                    context: { unit: m.unit, url: config.bitcoinRpc.url },
                },
            ]
        }
        return null
    },
}

/**
 * The gap between the measured BDK wallet balance and what CDK's ledger implies
 * it should be — and specifically, that gap CHANGING.
 *
 * The level is not alertable and never will be: the ledger accumulator was
 * seeded from a watermark rather than from genesis, so a constant historical
 * offset is expected and means nothing. What means something is the gap moving,
 * because everything that can move it is something CDK did not write a row for:
 *
 *   gap falling  — value left the wallet unbooked (a manual sweep, an on-chain
 *                  fee CDK did not account, a failed melt that still spent)
 *   gap rising   — value arrived outside any mint quote, so the mint holds coins
 *                  it has issued nothing against
 *
 * Partly overlapping with reserve drift, deliberately. Drift says the total
 * moved; this says which pool, and it catches the rising case that drift is
 * structurally unable to flag as a problem.
 *
 * Both endpoints must be on the WALLET basis. Comparing across the changeover
 * would measure the switch itself.
 */
export const walletLedgerDivergence: Rule = {
    id: 'mint_wallet_ledger_divergence',
    description: "BDK wallet balance is drifting away from CDK's ledger",
    defaults: {
        severity: 'WARNING',
        forEvaluations: 3,
        clearEvaluations: 3,
        cooldownSeconds: 21_600,
        params: {
            windowHours: 24,
            minSamples: 12,
            // Uncalibrated, and set wide on purpose (SPEC §12 step 9). Nothing in
            // the history says what a normal gap movement looks like yet, and a
            // tight guess would train the operator to dismiss this rule before it
            // ever had a chance to be right.
            thresholdSat: 50_000,
        },
    },
    async evaluate({ observation, prisma, params }) {
        if (!config.mintRpc.enabled) return null

        const unit = config.backingUnit
        const windowHours = numParam(params, 'windowHours', 24)
        const minSamples = numParam(params, 'minSamples', 12)
        const threshold = satParam(params, 'thresholdSat', 50_000)

        const since = new Date(observation.observedAt.getTime() - windowHours * 3_600_000)

        const rows = await prisma.reconciliation.findMany({
            where: {
                unit,
                mintOnchainBasis: 'WALLET',
                mintOnchainLedger: { not: null },
                observation: { observedAt: { gte: since } },
            },
            orderBy: { id: 'asc' },
            include: { observation: { select: { observedAt: true } } },
        })

        if (rows.length < minSamples) return null

        // Deposits awaiting credit are subtracted because they are the single
        // largest EXPLAINED reason the wallet leads the books: a confirmed
        // deposit is in the wallet immediately and in CDK's ledger only once it
        // books, which measured up to 55 minutes across 18 real deposits.
        //
        // Without this the rule fires on every ordinary on-chain mint — it did,
        // on 2026-08-16, for a 420,000 sat deposit against a perfectly valid
        // quote. A user paying on chain and returning hours later to mint is
        // normal behaviour, not a bookkeeping discrepancy, and a rule that
        // cannot tell the difference trains the operator to ignore it.
        //
        // Dust is subtracted for the same reason and is not a rounding detail: for
        // a long stretch it accounted for the ENTIRE baseline gap on this mint —
        // 9,608 sat of sub-minimum deposits CDK never booked, so the ledger cannot
        // see them and the wallet leads it by exactly that.
        //
        // `depositsUnattributed` belongs here for exactly the same reason dust
        // does, and omitting it made every correct operator liquidity injection
        // fire this rule: the wallet rises by the deposit while the ledger — which
        // reads mint_quote.amount_paid — never sees a quote-free payment at all.
        //
        // It is subtracted HERE ONLY. remainingDelta must keep leaving it alone:
        // an LND→BDK rebalance moves reserves not at all, so subtracting it there
        // would invent a shortfall. See Reconciliation.depositsUnattributed.
        //
        // Cumulative arrivals rather than value still held, which is correct: a
        // melt lowers the wallet and the ledger by the same amount, so spends
        // cancel and the gap stays equal to the sum of uncredited deposits.
        const gapOf = (r: (typeof rows)[number]) =>
            r.mintOnchain -
            (r.mintOnchainLedger ?? 0n) -
            r.depositsAwaitingCredit -
            r.dustReceived -
            r.depositsUnattributed

        const first = rows[0]
        const last = rows[rows.length - 1]
        const change = gapOf(last) - gapOf(first)

        const magnitude = change < 0n ? -change : change
        if (magnitude < threshold) return []

        const elapsedH =
            (last.observation.observedAt.getTime() - first.observation.observedAt.getTime()) /
            3_600_000

        // States what moved and lists what can move it. It must NOT name a cause:
        // the earlier wording inferred one from the sign alone and reported
        // "value arrived outside any mint quote" for a deposit that had a
        // perfectly good quote — sending the operator to look for a problem that
        // did not exist. Attribution belongs to the deposit classifier, which
        // actually checks; this rule only knows the gap moved.
        const candidates =
            change < 0n
                ? 'an on-chain fee CDK did not book, a manual withdrawal, or a melt that spent ' +
                  'without a completed_operations row'
                : 'a deposit against a quote created before the watchdog began discovery, or ' +
                  'funds sent to the wallet outside any quote'

        return [
            {
                dedupeKey: unit,
                title: `Mint on-chain wallet diverging from ledger by ${formatSat(change)} sat over ${windowHours}h`,
                detail:
                    `Candidates: ${candidates}. Wallet ${formatSat(last.mintOnchain)} sat vs ledger ` +
                    `${formatSat(last.mintOnchainLedger ?? 0n)} sat, less ` +
                    `${formatSat(last.depositsAwaitingCredit)} sat awaiting credit and ` +
                    `${formatSat(last.dustReceived)} sat of dust — ` +
                    `an unexplained gap of ${formatSat(gapOf(last))} sat, which moved ` +
                    `${formatSat(change)} sat across ${elapsedH.toFixed(1)}h. The level is not the ` +
                    `signal; the movement is. Threshold ${formatSat(threshold)} sat.`,
                context: {
                    unit,
                    samples: rows.length,
                    changeSat: (change / 1000n).toString(),
                    gapSat: (gapOf(last) / 1000n).toString(),
                },
            },
        ]
    },
}

/**
 * Whether the BDK wallet's view of the chain can be trusted at all.
 *
 * A stalled sync is the quiet failure here: BDK keeps answering GetBalance with
 * complete confidence, and the number it returns is simply the balance as of
 * whenever it stopped following the chain. Nothing in the balance itself says
 * so. LND's block height is an independent read of the same chain from a
 * separate daemon, which makes it the cheapest possible check — and it is
 * already on the observation.
 *
 * Network is checked in the same rule because it is the same question asked
 * once, at a different scale: whether the wallet being measured is the wallet
 * that actually holds the reserves.
 */
export const walletSync: Rule = {
    id: 'mint_wallet_sync',
    description: "The mint's BDK wallet is behind the chain, or on the wrong network",
    defaults: {
        severity: 'WARNING',
        forEvaluations: 3,
        clearEvaluations: 2,
        cooldownSeconds: 21_600,
        notifyOnResolve: true,
        params: { maxBlocksBehind: 6, expectedNetwork: 'bitcoin' },
    },
    async evaluate({ observation, params }) {
        if (!config.mintRpc.enabled) return null
        if (!observation.mints?.length) return null

        const maxBehind = numParam(params, 'maxBlocksBehind', 6)
        const expectedNetwork = String(
            (params as any)?.expectedNetwork ?? 'bitcoin',
        ).toLowerCase()

        const findings: RuleFinding[] = []

        for (const m of observation.mints) {
            if (m.unit !== config.backingUnit) continue

            // Not measured this tick — walletRpcUnreachable owns that case.
            if (m.walletSyncedHeight === null) return null

            if (m.walletNetwork && m.walletNetwork.toLowerCase() !== expectedNetwork) {
                findings.push({
                    dedupeKey: 'network',
                    severity: 'CRITICAL',
                    title: `Mint BDK wallet is on "${m.walletNetwork}", expected "${expectedNetwork}"`,
                    detail:
                        'The on-chain reserve figure is being read from a wallet on a different ' +
                        'network, so it describes no real reserves at all. Every reconciliation ' +
                        'row written while this holds is wrong.',
                    context: { network: m.walletNetwork, expectedNetwork },
                })
            }

            // LND's height is only a reference when LND itself is caught up.
            const lndHeight = observation.lnd?.syncedToChain ? observation.lnd.blockHeight : null
            if (lndHeight !== null) {
                const behind = lndHeight - m.walletSyncedHeight
                if (behind > maxBehind) {
                    findings.push({
                        dedupeKey: 'height',
                        title: `Mint BDK wallet is ${behind} blocks behind the chain`,
                        detail:
                            `Wallet at height ${m.walletSyncedHeight}, LND at ${lndHeight} ` +
                            `(threshold ${maxBehind}). The balance it reports is as of the wallet's ` +
                            `height, not now — deposits and spends after that point are missing from ` +
                            `reserves, and the figure will look stable while being stale.`,
                        context: {
                            walletHeight: m.walletSyncedHeight,
                            lndHeight,
                            behind,
                        },
                    })
                }
            }
            break
        }

        return findings
    },
}

/**
 * Windows in which a wallet movement is still "new".
 *
 * These are EVENTS: the transaction happened, and there is no ongoing condition
 * to clear. Emitting a finding only while the movement is fresh lets the alert
 * engine's own lifecycle do the work — it fires once, then the condition
 * disappears and it resolves silently.
 */
const MOVEMENT_FRESH_MS = 15 * 60_000

/** Reads the wallet movements the mint source attached to this observation. */
function freshMovements(observation: any): any[] {
    const raw = (observation.mints ?? []).find((m: any) => m.unit === config.backingUnit)?.raw ?? {}
    const movements: any[] = raw?.movements ?? []
    const cutoff = Date.now() - MOVEMENT_FRESH_MS
    return movements.filter((m) => new Date(m.firstObservedAt).getTime() >= cutoff)
}

/**
 * Denominator for "big": the wallet balance BEFORE the movement.
 *
 * Relative rather than absolute, as a fixed sat threshold either screams on a
 * small wallet or goes quiet as the wallet grows. Using the pre-movement balance
 * is what makes a deposit's percentage mean what a reader expects — the
 * 420,000 sat deposit of 2026-08-16 was 74% of the 570,355 that preceded it,
 * not 42% of the 990,355 that followed.
 */
function priorBalance(observation: any): bigint | null {
    const m = (observation.mints ?? []).find((x: any) => x.unit === config.backingUnit)
    if (!m || m.walletTrustedSpendable === null || m.walletTrustedSpendable === undefined) return null

    const balance = BigInt(m.walletTrustedSpendable)
    const delta = (freshMovements(observation) as any[]).reduce(
        (sum, mv) => sum + BigInt(mv.balanceDeltaMsat ?? 0),
        0n,
    )
    const before = balance - delta
    return before > 0n ? before : balance
}

function pct(part: bigint, whole: bigint): number {
    if (whole <= 0n) return 0
    return Number((part * 10_000n) / whole) / 100
}

/**
 * A single on-chain payment large relative to the wallet — a user minting.
 *
 * Keyed on the transaction, NOT the quote. CDK permits further payments to a
 * quote that has already been paid and issued against, and a wallet is not
 * prevented from doing it, so a quote-keyed alert would swallow every payment
 * after the first as a duplicate.
 */
export const largeOnchainMint: Rule = {
    id: 'mint_onchain_large_mint',
    description: 'Large on-chain deposit against a mint quote',
    defaults: {
        severity: 'INFO',
        forEvaluations: 1,
        clearEvaluations: 1,
        cooldownSeconds: 86_400,
        // EVENT: the deposit landed. Nothing clears, so a resolution notice
        // would double the message count for no information.
        notifyOnResolve: false,
        params: { fractionPct: 20 },
    },
    async evaluate({ observation, params }) {
        if (!config.mintRpc.enabled) return null

        const before = priorBalance(observation)
        if (before === null) return null

        const fraction = numParam(params, 'fractionPct', 20)
        const findings: RuleFinding[] = []

        for (const m of freshMovements(observation)) {
            const received = BigInt(m.receivedMsat ?? 0)
            if (BigInt(m.sentMsat ?? 0) !== 0n || received <= 0n) continue
            if (m.classification !== 'MINT_QUOTE') continue

            const share = pct(received, before)
            if (share < fraction) continue

            findings.push({
                dedupeKey: m.txid,
                title: `On-chain mint of ${formatSat(received)} sat — ${share.toFixed(1)}% of the wallet`,
                detail:
                    `Deposit against mint quote ${m.quoteId ?? 'unknown'}, tx ${String(m.txid).slice(0, 16)}…. ` +
                    `Wallet held ${formatSat(before)} sat before it. ` +
                    `Counted as unclaimed until the mint issues the ecash` +
                    (m.credited ? ' (already booked by the mint).' : ' (not yet booked by the mint).'),
                context: { txid: m.txid, quoteId: m.quoteId, sharePct: share },
            })
        }
        return findings
    },
}

/** The outgoing mirror, for the same liquidity-management reason. */
export const largeOnchainMelt: Rule = {
    id: 'mint_onchain_large_melt',
    description: 'Large on-chain withdrawal from the mint wallet',
    defaults: {
        severity: 'INFO',
        forEvaluations: 1,
        clearEvaluations: 1,
        cooldownSeconds: 86_400,
        notifyOnResolve: false,
        params: { fractionPct: 20 },
    },
    async evaluate({ observation, params }) {
        if (!config.mintRpc.enabled) return null

        const before = priorBalance(observation)
        if (before === null) return null

        const fraction = numParam(params, 'fractionPct', 20)
        const findings: RuleFinding[] = []

        for (const m of freshMovements(observation)) {
            const delta = BigInt(m.balanceDeltaMsat ?? 0)
            if (delta >= 0n) continue

            const out = -delta
            const share = pct(out, before)
            if (share < fraction) continue

            findings.push({
                dedupeKey: m.txid,
                title: `On-chain withdrawal of ${formatSat(out)} sat — ${share.toFixed(1)}% of the wallet`,
                detail:
                    `Net outflow in tx ${String(m.txid).slice(0, 16)}…, against a wallet of ` +
                    `${formatSat(before)} sat. CDK batches several melt quotes into one ` +
                    `transaction, so this is the movement rather than a single melt. If it does ` +
                    `not correspond to melts, it is an unbooked withdrawal and reserve drift ` +
                    `will follow.`,
                context: { txid: m.txid, sharePct: share },
            })
        }
        return findings
    },
}

/**
 * A confirmed deposit that paid no mint quote address.
 *
 * Operator liquidity, most likely — funded from outside the monitored perimeter,
 * or moved across from the LND wallet. Neither owes anyone ecash, which is why
 * these are deliberately kept OUT of unclaimed: booking a liability against the
 * operator's own capital would understate equity permanently.
 *
 * Reported rather than corrected. The watchdog cannot tell a deliberate
 * liquidity move from an unexpected arrival, and only the operator can — so it
 * says what it saw and leaves the judgement where it belongs.
 */
export const unattributedDeposit: Rule = {
    id: 'mint_onchain_deposit_unattributed',
    description: 'On-chain deposit with no matching mint quote',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 1,
        clearEvaluations: 2,
        cooldownSeconds: 86_400,
        notifyOnResolve: false,
    },
    async evaluate({ observation }) {
        if (!config.mintRpc.enabled) return null

        const findings: RuleFinding[] = []

        for (const m of freshMovements(observation)) {
            if (m.classification !== 'UNATTRIBUTED') continue
            const received = BigInt(m.receivedMsat ?? 0)
            if (received <= 0n) continue

            findings.push({
                dedupeKey: m.txid,
                title: `Unattributed on-chain deposit of ${formatSat(received)} sat`,
                detail:
                    `Tx ${String(m.txid).slice(0, 16)}… paid no address belonging to an on-chain ` +
                    `mint quote, so the mint owes no ecash for it. Excluded from unclaimed and ` +
                    `counted as own capital. Expected if you moved liquidity into the wallet; ` +
                    `worth investigating otherwise.`,
                context: { txid: m.txid },
            })
        }
        return findings
    },
}

/**
 * A dust deposit, announced ONCE when it first appears.
 *
 * Fires off the freshness window rather than off a standing condition, which is
 * the difference between an event and a nag. The rule this replaced tested "still
 * unbooked after 6h", and since a dust deposit is unbooked *forever* that
 * condition never cleared: it re-notified daily, per transaction, for as long as
 * the sats sat in the wallet — a 400 sat deposit reporting itself at 98 hours and
 * counting. What the operator actually needs is one notification per arrival, to
 * see how often it is happening.
 *
 * Nothing here watches the confirmed→booked lag on ordinary deposits any more.
 * Above the minimum, a deposit taking hours is normal operation: quotes never
 * expire, and a user who pays on chain and returns the next day to mint is
 * ordinary behaviour, not an anomaly. Those are reported only when they clear the
 * large-movement test.
 */
export const dustDeposit: Rule = {
    id: 'mint_onchain_dust_deposit',
    description: 'On-chain deposit below the mint minimum, which can never be credited',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 1,
        clearEvaluations: 1,
        cooldownSeconds: 86_400,
        notifyOnResolve: false,
    },
    async evaluate({ observation }) {
        if (!config.mintRpc.enabled) return null

        const findings: RuleFinding[] = []

        for (const m of freshMovements(observation)) {
            if (m.classification !== 'DUST') continue

            const amount = BigInt(m.receivedMsat ?? 0)

            findings.push({
                dedupeKey: m.txid,
                title: `Dust deposit of ${formatSat(amount)} sat — below the mint minimum`,
                detail:
                    `Tx ${String(m.txid).slice(0, 16)}… confirmed in the wallet, below ` +
                    `${config.mintOnchainMinReceiveSat.toLocaleString('en-US')} sat, so CDK will ` +
                    `never credit it — its check is on the individual receive and ignores what the ` +
                    `quote already holds. Booked straight to own capital; the mint owes nobody for ` +
                    `it. Harmless while it sits. It stops being harmless if the wallet co-spends ` +
                    `it, which links the sender's dust to the rest of the wallet — see ` +
                    `mint_onchain_dust_cospent.`,
                context: { txid: m.txid, amountSat: (amount / 1000n).toString() },
            })
        }
        return findings
    },
}

/**
 * The mint's wallet spent a deposit it never issued ecash for.
 *
 * This is a dusting attack paying off, and it is the only moment worth alerting
 * on — the dust arriving is harmless, and its value is trivially small. The
 * damage is done when the wallet CO-SPENDS it: the common-input-ownership
 * heuristic then attributes every other input address in that transaction to the
 * mint, and whoever sent the dust gets a map of the wallet for the price of a few
 * hundred sats.
 *
 * Deposit addresses are free to obtain. On-chain mint quotes are unauthenticated,
 * so anyone can request one and be handed a fresh address without the xpub ever
 * leaving the mint. Harvesting costs nothing but API calls, which makes the
 * co-spend the only defensible place to draw a line.
 *
 * The watchdog can only report it. Preventing it is coin control in CDK/BDK —
 * never selecting a sub-minimum UTXO as an input.
 */
export const dustCospent: Rule = {
    id: 'mint_onchain_dust_cospent',
    description: 'The wallet spent a deposit it never credited — address clustering exposure',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 1,
        clearEvaluations: 1,
        cooldownSeconds: 86_400,
        // EVENT: the transaction is confirmed and the linkage is permanent.
        // Nothing clears, and nothing can be undone.
        notifyOnResolve: false,
    },
    async evaluate({ observation }) {
        if (!config.mintRpc.enabled) return null

        const findings: RuleFinding[] = []

        for (const m of freshMovements(observation)) {
            const dust: string[] = m.cospentDust ?? []
            if (dust.length === 0) continue

            findings.push({
                dedupeKey: m.txid,
                title: `Wallet co-spent ${dust.length} never-credited deposit(s) — clustering exposure`,
                detail:
                    `Outgoing tx ${String(m.txid).slice(0, 16)}… drew on ${dust.length} deposit(s) ` +
                    `the mint never issued ecash for: ${dust.map((t) => t.slice(0, 12)).join(', ')}. ` +
                    `Whoever sent them can now attribute every other input of that transaction to ` +
                    `this wallet. The linkage is on chain and permanent. Preventing a repeat means ` +
                    `coin control in CDK — excluding sub-minimum UTXOs from input selection.`,
                context: { txid: m.txid, dust },
            })
        }
        return findings
    },
}

export const mintRules = [
    mintUnreachable,
    mintOverIssued,
    mintSchemaAccess,
    mintKeysetChange,
    proofsPendingHigh,
    meltRequestsStuck,
    onchainMeltStuck,
    walletRpcUnreachable,
    chainSourceUnreachable,
    walletLedgerDivergence,
    walletSync,
    largeOnchainMint,
    largeOnchainMelt,
    unattributedDeposit,
    dustDeposit,
    dustCospent,
]
