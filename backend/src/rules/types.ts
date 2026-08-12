import type { PrismaClient, Severity } from '@prisma/client'

/**
 * A rule reports the subjects that are *currently* in violation. It has no
 * knowledge of firing, resolving, cooldowns or notification — that lifecycle
 * belongs entirely to the alert engine (SPEC.md §7).
 *
 * Keeping rules stateless makes them trivially unit-testable: given an
 * observation, they either return findings or they do not.
 */

export interface RuleFinding {
    /**
     * Identifies the subject within this rule. A rule tracking one thing can use
     * a constant; a rule tracking many (one alert per stuck quote) uses the
     * subject's id, so alerts do not collapse into a single indistinguishable one.
     */
    dedupeKey: string
    title: string
    detail?: string
    context?: Record<string, unknown>
    /** Overrides the rule's configured severity for this particular finding. */
    severity?: Severity
}

export interface ObservationWithRelations {
    id: number
    observedAt: Date
    lndStatus: string
    mintStatus: string
    lndError: string | null
    mintError: string | null
    lnd: any | null
    mints: any[]
    reconciliation: any | null
}

export interface RuleContext {
    observation: ObservationWithRelations
    prisma: PrismaClient
    /** Merged rule params: code defaults overlaid with the DB row. */
    params: Record<string, any>
    /**
     * dedupeKeys this rule currently has firing.
     *
     * Lets a rule apply *value* hysteresis — a wider band to clear than to fire —
     * on top of the engine's duration hysteresis. Without it, a metric hovering
     * at the threshold produces an endless fire/resolve stream even though the
     * duration counters are working correctly.
     */
    firingKeys: Set<string>
}

export interface RuleDefaults {
    enabled?: boolean
    severity?: Severity
    /** Evaluations the condition must hold before firing. */
    forEvaluations?: number
    /** Evaluations it must be absent before resolving — the hysteresis. */
    clearEvaluations?: number
    /** Minimum seconds between repeat notifications while still firing. */
    cooldownSeconds?: number
    /**
     * Whether clearing notifies. Default true.
     *
     * Set false for EVENT-style rules — ones describing something that happened
     * rather than an ongoing condition. A collection gap or a keyset rotation
     * has nothing to "clear", so a resolution notice is noise that doubles the
     * notification cost of every occurrence. The alert still auto-resolves so
     * the active list stays clean; only the notification is suppressed.
     */
    notifyOnResolve?: boolean
    params?: Record<string, any>
}

export interface Rule {
    id: string
    description: string
    defaults: RuleDefaults

    /**
     * Returns the subjects currently in violation.
     *
     * **Return `null` when the rule could not be evaluated** — typically because
     * its source failed this tick, so `observation.lnd` or `observation.mints`
     * is absent. That is NOT the same as returning `[]`.
     *
     * `[]` asserts "I checked, and nothing is wrong", which lets the engine count
     * a miss and eventually RESOLVE the alert. Returning `[]` on missing data
     * would tell the operator a force-close cleared itself simply because LND
     * went unreachable — and then re-fire on reconnect. A monitoring tool must
     * never claim a problem went away when it merely stopped looking.
     *
     * On `null` the engine leaves every counter and state for this rule
     * untouched: no hit, no miss, no transition.
     */
    evaluate(ctx: RuleContext): Promise<RuleFinding[] | null>
}

/** sat in config (human-readable) → msat internally. */
export function satParam(params: Record<string, any>, key: string, fallbackSat: number): bigint {
    const v = params[key]
    const sat = typeof v === 'number' ? v : fallbackSat
    return BigInt(Math.trunc(sat)) * 1000n
}

export function numParam(params: Record<string, any>, key: string, fallback: number): number {
    const v = params[key]
    return typeof v === 'number' ? v : fallback
}

export function formatSat(msat: bigint): string {
    return (msat / 1000n).toLocaleString('en-US')
}
