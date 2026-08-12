import { Rule, RuleFinding, formatSat, numParam, satParam } from './types'

export const lndUnreachable: Rule = {
    id: 'lnd_unreachable',
    description: 'LND did not respond to the collector',
    defaults: {
        severity: 'CRITICAL',
        forEvaluations: 2,
        clearEvaluations: 1,
        cooldownSeconds: 1800,
    },
    async evaluate({ observation }) {
        const s = observation.lndStatus
        if (s === 'OK' || s === 'SKIPPED') return []
        return [
            {
                dedupeKey: 'lnd',
                title: `LND unreachable (${s})`,
                detail: observation.lndError ?? undefined,
            },
        ]
    },
}

export const lndNotSynced: Rule = {
    id: 'lnd_not_synced',
    description: 'LND is not synced to chain or graph',
    defaults: { severity: 'WARNING', forEvaluations: 3, clearEvaluations: 2 },
    async evaluate({ observation }) {
        const lnd = observation.lnd
        // No snapshot means LND could not be read. Signal 'no information' so
        // the engine freezes state instead of resolving a live condition.
        if (!lnd) return null
        const findings: RuleFinding[] = []
        if (!lnd.syncedToChain) {
            findings.push({
                dedupeKey: 'chain',
                title: 'LND not synced to chain',
                detail: `block height ${lnd.blockHeight}`,
                severity: 'CRITICAL',
            })
        }
        if (!lnd.syncedToGraph) {
            findings.push({ dedupeKey: 'graph', title: 'LND not synced to graph' })
        }
        return findings
    },
}

/**
 * Force-closes tie up funds behind a timelock. The balance is still counted in
 * Total node balance, so this does not affect reconciliation — it is an
 * operational alert, not a solvency one.
 */
export const lndForceClose: Rule = {
    id: 'lnd_force_close',
    description: 'Channels force-closing, or funds in limbo',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 1,
        clearEvaluations: 3,
        cooldownSeconds: 86_400,
        params: { limboThresholdSat: 1 },
    },
    async evaluate({ observation, params }) {
        const lnd = observation.lnd
        // No snapshot means LND could not be read. Signal 'no information' so
        // the engine freezes state instead of resolving a live condition.
        if (!lnd) return null

        const limbo = BigInt(lnd.limbo)
        const threshold = satParam(params, 'limboThresholdSat', 1)

        if (lnd.pendingForceCloseCount === 0 && limbo < threshold) return []

        return [
            {
                dedupeKey: 'force_close',
                title: `${lnd.pendingForceCloseCount} force-closing channel(s), ${formatSat(limbo)} sat in limbo`,
                detail: `waiting-close: ${lnd.waitingCloseCount}, pending-open: ${lnd.pendingOpenCount}`,
                context: {
                    pendingForceCloseCount: lnd.pendingForceCloseCount,
                    limboSat: (limbo / 1000n).toString(),
                },
            },
        ]
    },
}

export const lndInactiveChannels: Rule = {
    id: 'lnd_inactive_channels',
    description: 'Too many inactive channels',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 3,
        clearEvaluations: 3,
        params: { maxInactive: 3 },
    },
    async evaluate({ observation, params }) {
        const lnd = observation.lnd
        // No snapshot means LND could not be read. Signal 'no information' so
        // the engine freezes state instead of resolving a live condition.
        if (!lnd) return null

        const max = numParam(params, 'maxInactive', 3)
        if (lnd.numInactiveChannels <= max) return []

        return [
            {
                dedupeKey: 'inactive',
                title: `${lnd.numInactiveChannels} inactive channels (threshold ${max})`,
                detail: `${lnd.numActiveChannels} active`,
            },
        ]
    },
}

export const lndRules = [lndUnreachable, lndNotSynced, lndForceClose, lndInactiveChannels]
