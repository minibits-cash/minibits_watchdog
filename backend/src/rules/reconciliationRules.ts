import { Rule, RuleDefaults, formatSat, numParam, satParam } from './types'
import { config } from '../config'

/**
 * Reserve drift: the core solvency rule. See SPEC.md §3.
 *
 * Measures `Remaining delta` as a RATE over a fixed window rather than per-tick,
 * so the number means the same thing regardless of collection interval or a
 * missed sample:
 *
 *   Remaining delta = Δ Own capital − Δ Total unclaimed
 *   rate            = Remaining delta / elapsed hours
 *
 * Computed from the window endpoints, not by summing per-tick deltas, so gaps in
 * the series cannot accumulate error.
 *
 * The comparison baseline is NOT zero. The mint is legitimately over-capitalised
 * over time by Lightning routing fee income and by rounding Lightning fees up to
 * whole sats. (It is *not* over-capitalised by input fees — every keyset has
 * input_fee_ppk = 0.) Alerting against zero would drift into a permanent false
 * positive as volume grows, so `expectedDriftSatPerHour` is configurable and
 * calibrated from history.
 *
 * Value hysteresis: the bar to clear is higher than the bar to fire, so a rate
 * hovering at the threshold does not produce an endless fire/resolve stream.
 */
function makeReserveDriftRule(id: string, description: string, defaults: RuleDefaults): Rule {
    return {
        id,
        description,
        defaults,

        async evaluate({ observation, prisma, params, firingKeys }) {
            const unit = config.backingUnit
            const windowHours = numParam(params, 'windowHours', 6)
            const minSamples = numParam(params, 'minSamples', 4)
            const minSpanFraction = numParam(params, 'minSpanFraction', 0.5)

            const since = new Date(observation.observedAt.getTime() - windowHours * 3_600_000)

            const rows = await prisma.reconciliation.findMany({
                where: { unit, observation: { observedAt: { gte: since } } },
                orderBy: { id: 'asc' },
                include: { observation: { select: { observedAt: true } } },
            })

            // Too little history to say anything. Silence here is correct:
            // asserting "no drift" from two samples would be worse than nothing.
            if (rows.length < minSamples) return []

            const first = rows[0]
            const last = rows[rows.length - 1]
            const elapsedMs = last.observation.observedAt.getTime() - first.observation.observedAt.getTime()

            // Guard against a window whose samples are all bunched at one end —
            // a short span makes the rate wildly over-sensitive.
            if (elapsedMs < windowHours * 3_600_000 * minSpanFraction) return []

            const deltaOwnCapital = last.ownCapital - first.ownCapital
            const deltaUnclaimed = last.unclaimed - first.unclaimed
            const remaining = deltaOwnCapital - deltaUnclaimed

            const ratePerHour = (remaining * 3_600_000n) / BigInt(elapsedMs)

            // How continuously was the window actually observed? The endpoints
            // are real readings either way, so a gap does not invalidate the
            // measured change — but a rate quoted "per hour" across mostly
            // unobserved time invites the wrong conclusion, so it is stated
            // rather than hidden.
            let maxGapMs = 0
            for (let i = 1; i < rows.length; i++) {
                const gap =
                    rows[i].observation.observedAt.getTime() -
                    rows[i - 1].observation.observedAt.getTime()
                if (gap > maxGapMs) maxGapMs = gap
            }
            const gapNote =
                maxGapMs > config.collect.intervalMs * 3
                    ? ` NOTE: window contains a ${(maxGapMs / 3_600_000).toFixed(1)}h collection gap — ` +
                      `the endpoints are real, but the intervening period was unobserved.`
                    : ''

            const expected = satParam(params, 'expectedDriftSatPerHour', 0)
            const fireBelow = expected - satParam(params, 'toleranceSatPerHour', 10_000)
            const clearBelow = expected - satParam(params, 'clearToleranceSatPerHour', 5_000)

            // Wider band to clear than to fire.
            const threshold = firingKeys.has(unit) ? clearBelow : fireBelow

            if (ratePerHour >= threshold) return []

            return [
                {
                    dedupeKey: unit,
                    title: `Reserve drift ${formatSat(ratePerHour)} sat/h over ${windowHours}h (${unit})`,
                    detail:
                        `Remaining delta ${formatSat(remaining)} sat across ${(elapsedMs / 3_600_000).toFixed(1)}h. ` +
                        `Expected ${formatSat(expected)} sat/h, alert below ${formatSat(fireBelow)} sat/h. ` +
                        `Δ own capital ${formatSat(deltaOwnCapital)} sat, Δ unclaimed ${formatSat(deltaUnclaimed)} sat.` +
                        gapNote,
                    context: {
                        unit,
                        windowHours,
                        samples: rows.length,
                        ratePerHourSat: (ratePerHour / 1000n).toString(),
                        remainingSat: (remaining / 1000n).toString(),
                        maxGapMs,
                    },
                },
            ]
        },
    }
}

/** Sharp drop over a short window. */
export const reserveDriftShort = makeReserveDriftRule(
    'reserve_drift_short',
    'Reserve declining sharply over a short window',
    {
        severity: 'CRITICAL',
        forEvaluations: 2,
        clearEvaluations: 3,
        cooldownSeconds: 3600,
        params: {
            windowHours: 6,
            minSamples: 4,
            expectedDriftSatPerHour: 0,
            toleranceSatPerHour: 20_000,
            clearToleranceSatPerHour: 10_000,
        },
    },
)

/** Slow bleed that a short window would never notice. */
export const reserveDriftLong = makeReserveDriftRule(
    'reserve_drift_long',
    'Reserve declining slowly over a long window',
    {
        severity: 'WARNING',
        forEvaluations: 3,
        clearEvaluations: 3,
        cooldownSeconds: 21_600,
        params: {
            windowHours: 48,
            minSamples: 24,
            expectedDriftSatPerHour: 0,
            toleranceSatPerHour: 2_000,
            clearToleranceSatPerHour: 1_000,
        },
    },
)

export const reconciliationRules = [reserveDriftShort, reserveDriftLong]
