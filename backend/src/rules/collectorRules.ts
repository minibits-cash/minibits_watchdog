import { Rule, numParam } from './types'
import { config } from '../config'

/**
 * A gap between observations means the watchdog was not watching.
 *
 * This can only ever fire *after* collection resumes — a process that is down
 * runs no rules at all. Detecting the outage while it is happening is the
 * deadman's switch's job (SPEC.md §8), not this rule's. What this gives is the
 * record afterwards: it marks the window during which reserve figures were
 * unobserved, so a step change either side of it is not mistaken for a
 * continuous trend.
 */
export const observationGap: Rule = {
    id: 'collector_observation_gap',
    description: 'Gap between observations larger than expected',
    defaults: {
        severity: 'WARNING',
        forEvaluations: 1,
        clearEvaluations: 1,
        cooldownSeconds: 3600,
        // EVENT, not state: the gap happened and is over. Notifying again when
        // it "clears" would make every restart cost two notifications.
        notifyOnResolve: false,
        params: { toleranceMultiple: 3 },
    },

    async evaluate({ observation, prisma, params }) {
        const prev = await prisma.observation.findFirst({
            where: { id: { lt: observation.id } },
            orderBy: { id: 'desc' },
            select: { observedAt: true },
        })
        if (!prev) return []

        const gapMs = observation.observedAt.getTime() - prev.observedAt.getTime()
        const allowed = config.collect.intervalMs * numParam(params, 'toleranceMultiple', 3)

        if (gapMs <= allowed) return []

        const minutes = Math.round(gapMs / 60_000)
        return [
            {
                // Keyed on the gap itself so each outage is its own alert rather
                // than overwriting the last one.
                dedupeKey: prev.observedAt.toISOString(),
                title: `Collection gap of ${minutes} minutes`,
                detail:
                    `No observations between ${prev.observedAt.toISOString()} and ` +
                    `${observation.observedAt.toISOString()}. Reserve figures were unobserved across this window.`,
                context: { gapMs, expectedIntervalMs: config.collect.intervalMs },
            },
        ]
    },
}

export const collectorRules = [observationGap]
