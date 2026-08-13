import prisma from '../utils/prismaClient'
import { log } from '../services/logService'
import { getNotifier, Notification, redactAmounts } from './notifier'
import { pingHeartbeat } from '../services/heartbeat'
import { config } from '../config'
import { allRules } from '../rules'
import type { Rule, RuleContext, RuleFinding, ObservationWithRelations } from '../rules/types'
import type { AlertState, RuleConfig, Severity } from '@prisma/client'

/**
 * Alert lifecycle. See SPEC.md §7.
 *
 * The state machine, not the rules, is what makes this tool survivable:
 *
 *   - `forEvaluations`   — the condition must hold N consecutive evaluations
 *                          before firing, so transient in-flight states (a melt
 *                          mid-payment, a sample landing between HTLC settle)
 *                          never page anyone.
 *   - `clearEvaluations` — it must be absent N evaluations before resolving.
 *                          Asymmetric with the above, which is the hysteresis:
 *                          without it a condition oscillating around a threshold
 *                          produces an unbounded stream of fire/resolve pairs.
 *   - `cooldownSeconds`  — minimum gap between repeat notifications while still
 *                          firing, so a real ongoing problem notifies once an
 *                          hour rather than every five minutes.
 *
 * Counters advance once per evaluation, so "N evaluations" means N × the collect
 * interval in wall-clock terms.
 */

export interface EvaluationSummary {
    observationId: number
    rulesEvaluated: number
    /** Rules that could not be evaluated because their source was unavailable. */
    rulesSkipped: number
    findings: number
    fired: number
    resolved: number
    renotified: number
    errors: { ruleId: string; message: string }[]
}

export async function evaluateRules(
    observation: ObservationWithRelations,
): Promise<EvaluationSummary> {
    const summary: EvaluationSummary = {
        observationId: observation.id,
        rulesEvaluated: 0,
        rulesSkipped: 0,
        findings: 0,
        fired: 0,
        resolved: 0,
        renotified: 0,
        errors: [],
    }

    const configs = await loadConfigs()

    for (const rule of allRules) {
        const cfg = configs.get(rule.id)!

        if (!cfg.enabled) continue

        let findings: RuleFinding[] | null = null

        try {
            const firing = await prisma.alertState.findMany({
                where: { ruleId: rule.id, status: 'FIRING' },
                select: { dedupeKey: true },
            })
            const ctx: RuleContext = {
                observation,
                prisma,
                params: { ...(rule.defaults.params ?? {}), ...((cfg.params as object) ?? {}) },
                firingKeys: new Set(firing.map((f) => f.dedupeKey)),
            }
            findings = await rule.evaluate(ctx)
            if (findings === null) summary.rulesSkipped++
            else summary.rulesEvaluated++
        } catch (e: any) {
            // A broken rule must not stop the others, and must not look like
            // "condition not met" — that would silently disable monitoring.
            const message = String(e?.message ?? e)
            summary.errors.push({ ruleId: rule.id, message })
            log.error('[alerts] rule threw, skipping', { ruleId: rule.id, message })
            continue
        }

        // null means the rule had no data to judge by. Leave its alert states
        // exactly as they are — no hit, no miss, no transition. Counting a miss
        // here is what previously resolved a force-close alert simply because
        // LND went unreachable.
        if (findings === null) {
            log.debug('[alerts] rule not evaluable this tick, state frozen', { ruleId: rule.id })
            continue
        }

        summary.findings += findings.length
        await applyFindings(rule, cfg, findings, summary)
    }

    if (summary.fired || summary.resolved || summary.renotified || summary.errors.length) {
        log.info('[alerts] evaluation complete', summary)
    }

    return summary
}

async function applyFindings(
    rule: Rule,
    cfg: RuleConfig,
    findings: RuleFinding[],
    summary: EvaluationSummary,
): Promise<void> {
    const now = new Date()
    const byKey = new Map(findings.map((f) => [f.dedupeKey, f]))

    const existing = await prisma.alertState.findMany({ where: { ruleId: rule.id } })
    const existingByKey = new Map(existing.map((s) => [s.dedupeKey, s]))

    // Subjects currently in violation.
    for (const [key, finding] of byKey) {
        const prev = existingByKey.get(key)
        const severity: Severity = finding.severity ?? cfg.severity

        if (!prev) {
            const created = await prisma.alertState.create({
                data: {
                    ruleId: rule.id,
                    dedupeKey: key,
                    status: 'PENDING', // promoted below once the `for` duration is met
                    severity,
                    title: finding.title,
                    detail: finding.detail ?? null,
                    context: (finding.context as any) ?? undefined,
                    consecutiveHits: 1,
                    consecutiveMisses: 0,
                    firstSeenAt: now,
                    lastEvaluatedAt: now,
                },
            })
            await maybeFire(created, cfg, finding, severity, now, summary)
            continue
        }

        const updated = await prisma.alertState.update({
            where: { id: prev.id },
            data: {
                consecutiveHits: prev.consecutiveHits + 1,
                consecutiveMisses: 0,
                title: finding.title,
                detail: finding.detail ?? null,
                context: (finding.context as any) ?? undefined,
                severity,
                lastEvaluatedAt: now,
            },
        })

        if (updated.status === 'FIRING') {
            await maybeRenotify(updated, cfg, finding, severity, now, summary)
        } else {
            await maybeFire(updated, cfg, finding, severity, now, summary)
        }
    }

    // Subjects no longer in violation.
    for (const state of existing) {
        if (byKey.has(state.dedupeKey)) continue

        const updated = await prisma.alertState.update({
            where: { id: state.id },
            data: {
                consecutiveMisses: state.consecutiveMisses + 1,
                consecutiveHits: 0,
                lastEvaluatedAt: now,
            },
        })

        // A PENDING state that never reached the `for` threshold is discarded
        // rather than left to accumulate — it never notified anyone, so there is
        // nothing to resolve and no history worth keeping.
        if (updated.status === 'PENDING') {
            if (updated.consecutiveMisses >= cfg.clearEvaluations) {
                await prisma.alertState.delete({ where: { id: updated.id } })
            }
            continue
        }

        if (updated.status !== 'FIRING') continue

        if (updated.consecutiveMisses >= cfg.clearEvaluations) {
            await prisma.alertState.update({
                where: { id: updated.id },
                data: { status: 'RESOLVED', resolvedAt: now },
            })
            await record(updated.id, 'RESOLVED', `cleared after ${updated.consecutiveMisses} evaluations`)

            // Event-style rules resolve silently: the occurrence was already
            // notified, and "the gap that happened has stopped happening" is not
            // information.
            if (cfg.notifyOnResolve) {
                await notify({
                    ruleId: rule.id,
                    dedupeKey: updated.dedupeKey,
                    severity: updated.severity,
                    title: updated.title,
                    detail: 'Condition cleared.',
                    resolved: true,
                }, updated.id)
            }
            summary.resolved++
        }
    }
}

async function maybeFire(
    state: AlertState,
    cfg: RuleConfig,
    finding: RuleFinding,
    severity: Severity,
    now: Date,
    summary: EvaluationSummary,
): Promise<void> {
    if (state.consecutiveHits < cfg.forEvaluations) return

    await prisma.alertState.update({
        where: { id: state.id },
        data: {
            status: 'FIRING',
            firedAt: now,
            resolvedAt: null,
            lastNotifiedAt: now,
            // Reset rather than increment: firing starts a NEW episode, and the
            // AlertState row is reused across episodes. Accumulating would make
            // "notified 3×" sit beside a firedAt from minutes ago and read as
            // three pages about the current incident. Episode history lives in
            // AlertEvent, which is append-only.
            notifyCount: 1,
        },
    })
    await record(state.id, 'FIRED', `held for ${state.consecutiveHits} evaluations`)
    await notify({
        ruleId: state.ruleId,
        dedupeKey: state.dedupeKey,
        severity,
        title: finding.title,
        detail: finding.detail,
        resolved: false,
        context: finding.context,
    }, state.id)
    summary.fired++
}

async function maybeRenotify(
    state: AlertState,
    cfg: RuleConfig,
    finding: RuleFinding,
    severity: Severity,
    now: Date,
    summary: EvaluationSummary,
): Promise<void> {
    const last = state.lastNotifiedAt?.getTime() ?? 0
    if (now.getTime() - last < cfg.cooldownSeconds * 1000) return

    await prisma.alertState.update({
        where: { id: state.id },
        data: { lastNotifiedAt: now, notifyCount: { increment: 1 } },
    })
    await record(state.id, 'RENOTIFIED', `still firing since ${state.firedAt?.toISOString() ?? 'unknown'}`)
    await notify({
        ruleId: state.ruleId,
        dedupeKey: state.dedupeKey,
        severity,
        title: finding.title,
        detail: finding.detail,
        resolved: false,
        context: finding.context,
    }, state.id)
    summary.renotified++
}

async function notify(n: Notification, alertStateId: number): Promise<void> {
    try {
        // Redaction is a property of each transport now (see withRedaction),
        // because a public topic and a private mailbox are different exposures.
        await getNotifier().send(n)
    } catch (e: any) {
        // Never swallow: a silent delivery failure is indistinguishable from
        // "no alerts", which is the state we can least afford to misread.
        const message = String(e?.message ?? e)
        log.error('[alerts] notification failed', { ruleId: n.ruleId, message })
        await record(alertStateId, 'NOTIFY_FAILED', message)

        // Escalate to the deadman's switch. If alerts cannot be delivered, the
        // operator must learn that through the one channel that does not depend
        // on the notifier working.
        await pingHeartbeat(false, `notification failed for ${n.ruleId}: ${message}`)
    }
}

async function record(alertStateId: number, kind: any, detail: string): Promise<void> {
    await prisma.alertEvent.create({ data: { alertStateId, kind, detail } })
}

/** Ensures a RuleConfig row exists for every registered rule, seeded from code defaults. */
export async function loadConfigs(): Promise<Map<string, RuleConfig>> {
    const rows = await prisma.ruleConfig.findMany()
    const byId = new Map(rows.map((r) => [r.ruleId, r]))

    for (const rule of allRules) {
        if (byId.has(rule.id)) continue
        const d = rule.defaults
        const created = await prisma.ruleConfig.create({
            data: {
                ruleId: rule.id,
                enabled: d.enabled ?? true,
                severity: d.severity ?? 'WARNING',
                forEvaluations: d.forEvaluations ?? 2,
                clearEvaluations: d.clearEvaluations ?? 2,
                cooldownSeconds: d.cooldownSeconds ?? 3600,
                notifyOnResolve: d.notifyOnResolve ?? true,
                params: (d.params as any) ?? {},
            },
        })
        byId.set(rule.id, created)
        log.info('[alerts] seeded rule config', { ruleId: rule.id })
    }

    return byId
}
