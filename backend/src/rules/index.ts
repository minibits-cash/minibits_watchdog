import { Rule } from './types'
import { lndRules } from './lndRules'
import { mintRules } from './mintRules'
import { reconciliationRules } from './reconciliationRules'
import { collectorRules } from './collectorRules'

/**
 * Rule registry.
 *
 * Rules are plain TypeScript modules in an array rather than rows in a DSL:
 * typed, unit-testable, and refactorable. Only the *tuning* lives in the
 * database (RuleConfig), so thresholds change without a redeploy while the logic
 * stays under version control and review.
 */
export const allRules: Rule[] = [
    ...lndRules,
    ...mintRules,
    ...reconciliationRules,
    ...collectorRules,
]

export function getRule(id: string): Rule | undefined {
    return allRules.find((r) => r.id === id)
}

// Fail fast on a duplicate id: two rules sharing one id would silently share
// AlertState rows and overwrite each other's alerts.
const seen = new Set<string>()
for (const r of allRules) {
    if (seen.has(r.id)) {
        throw new Error(`Duplicate rule id: ${r.id}`)
    }
    seen.add(r.id)
}
