import { Rule, RuleFinding, formatSat, numParam, satParam } from './types'

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

export const mintRules = [
    mintUnreachable,
    mintOverIssued,
    mintSchemaAccess,
    mintKeysetChange,
    proofsPendingHigh,
    meltRequestsStuck,
    onchainMeltStuck,
]
