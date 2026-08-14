import { log } from '../services/logService'
import type { Severity } from '@prisma/client'

/**
 * Notification transport.
 *
 * Two constraints hold regardless of implementation (SPEC.md §8):
 *
 *   1. Delivery must not depend on what is being monitored. "The mint database
 *      is down" still has to reach the operator.
 *   2. A failed send must be recorded, never swallowed. A notifier that fails
 *      silently turns every alert into silence, which is indistinguishable from
 *      "nothing is wrong" — the most dangerous state a watchdog can be in.
 */

export interface Notification {
    ruleId: string
    dedupeKey: string
    severity: Severity
    title: string
    detail?: string
    /** RESOLVED notifications close the loop so a silent alert is not assumed fixed. */
    resolved: boolean
    context?: Record<string, unknown>
    /**
     * Set by redactAmounts so a transport can say WHY the figures are missing.
     *
     * Without it a redacted alert reads as a broken one: the operator sees `***`
     * or a bare subject and cannot tell a privacy setting from a bug — and
     * "the alerting looks broken" is the one conclusion a watchdog must never
     * invite by accident.
     */
    redacted?: boolean
}

export interface Notifier {
    readonly name: string
    /** True when this transport's payloads pass through redaction. */
    readonly redacted?: boolean
    send(n: Notification): Promise<void>
}

/**
 * Placeholder until the ntfy transport lands in step 7. Deliberately logs at
 * WARN/ERROR so an unconfigured notifier is visible rather than quietly inert.
 */
export class LogNotifier implements Notifier {
    readonly name = 'log'

    async send(n: Notification): Promise<void> {
        const prefix = n.resolved ? '[alert RESOLVED]' : `[alert ${n.severity}]`
        const line = `${prefix} ${n.ruleId}/${n.dedupeKey}: ${n.title}`

        if (n.resolved || n.severity === 'INFO') {
            log.info(line, n.detail ? { detail: n.detail } : {})
        } else if (n.severity === 'WARNING') {
            log.warn(line, n.detail ? { detail: n.detail } : {})
        } else {
            log.error(line, n.detail ? { detail: n.detail } : {})
        }
    }
}

/**
 * Remove numeric amounts from an outbound alert.
 *
 * Alert text carries the mint's reserve figures, channel balances and pending
 * totals. On a third-party transport — a public ntfy.sh topic, or a mailbox the
 * provider can read — that publishes the mint's finances to whoever holds the
 * channel.
 *
 * Severity, rule id and subject survive, so the alert still conveys urgency and
 * points at what to look at; the figures are then read from the dashboard over
 * the SSH tunnel. Applied per transport via NTFY_REDACT_AMOUNTS /
 * EMAIL_REDACT_AMOUNTS — see withRedaction below.
 *
 * Matches digit groups with separators (1,234,567 / 1234567 / 12.5) rather than
 * all digits, so identifiers, counts and timestamps stay intact.
 */
export function redactAmounts(n: Notification): Notification {
    const strip = (s: string | undefined) =>
        s?.replace(/\b\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?\b|\b\d{4,}(?:\.\d+)?\b/g, '***')

    return {
        ...n,
        title: strip(n.title) ?? n.title,
        detail: strip(n.detail),
        // Context is stored locally, never transmitted, so it is dropped rather
        // than redacted.
        context: undefined,
        redacted: true,
    }
}

/**
 * Wrap a transport so its payload is redacted before sending.
 *
 * Redaction used to happen once in the engine, which guaranteed no transport
 * could bypass it. Per-transport policy makes that impossible, so the guarantee
 * is re-established differently: there is still exactly ONE implementation of
 * redaction, and it is applied at the single place transports are constructed
 * (index.ts). A new transport is wired there or it does not run at all.
 *
 * `name` deliberately mirrors the wrapped transport, so log lines and
 * `notify_transport_failed` events stay comparable across a change of setting.
 * The `redacted` flag carries the distinction instead.
 */
export function withRedaction(target: Notifier): Notifier {
    return {
        name: target.name,
        redacted: true,
        send: (n) => target.send(redactAmounts(n)),
    }
}

let notifier: Notifier = new LogNotifier()

export function getNotifier(): Notifier {
    return notifier
}

export function setNotifier(n: Notifier): void {
    notifier = n
    log.info('[notifier] transport set', { name: n.name })
}
