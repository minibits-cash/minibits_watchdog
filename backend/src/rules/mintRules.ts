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
 * An on-chain melt still committed past the window in which the watchdog trusts
 * it as a wallet-balance correction.
 *
 * This is the alert half of a deliberate trade. Inside the window a committed
 * melt is subtracted from on-chain reserves, because its transaction has left
 * the BDK wallet. Past it, the transaction may instead have been dropped — which
 * returns the funds — so the collector stops subtracting and reports it here.
 * Either way the on-chain reserve figure is no longer trustworthy while this
 * fires, which is precisely when a human should look rather than a heuristic
 * guess.
 *
 * State-style, so it resolves: unlike a collection gap, "the melt is no longer
 * stuck" is information — it says the reserve figure can be trusted again.
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
                    `subtracted from on-chain reserves, so that figure may be overstated by up to ` +
                    `that amount. Check whether the transaction confirmed, was dropped, or is still ` +
                    `in the mempool.`,
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

        const gapOf = (r: (typeof rows)[number]) => r.mintOnchain - (r.mintOnchainLedger ?? 0n)

        const first = rows[0]
        const last = rows[rows.length - 1]
        const change = gapOf(last) - gapOf(first)

        const magnitude = change < 0n ? -change : change
        if (magnitude < threshold) return []

        const elapsedH =
            (last.observation.observedAt.getTime() - first.observation.observedAt.getTime()) /
            3_600_000

        const direction =
            change < 0n
                ? 'value left the wallet that CDK never booked'
                : 'value arrived in the wallet outside any mint quote'

        return [
            {
                dedupeKey: unit,
                title: `Mint on-chain wallet diverging from ledger by ${formatSat(change)} sat over ${windowHours}h`,
                detail:
                    `${direction}. Wallet ${formatSat(last.mintOnchain)} sat vs ledger ` +
                    `${formatSat(last.mintOnchainLedger ?? 0n)} sat — a gap of ` +
                    `${formatSat(gapOf(last))} sat, which moved ${formatSat(change)} sat across ` +
                    `${elapsedH.toFixed(1)}h. The level is not the signal; the movement is. ` +
                    `Threshold ${formatSat(threshold)} sat.`,
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

export const mintRules = [
    mintUnreachable,
    mintOverIssued,
    mintSchemaAccess,
    mintKeysetChange,
    proofsPendingHigh,
    meltRequestsStuck,
    onchainMeltStuck,
    walletRpcUnreachable,
    walletLedgerDivergence,
    walletSync,
]
