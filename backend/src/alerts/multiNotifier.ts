import prisma from '../utils/prismaClient'
import { log } from '../services/logService'
import { Notification, Notifier } from './notifier'

/**
 * Fan-out across every configured transport.
 *
 * Delivery redundancy matters more here than anywhere else in the system: this
 * is the one component whose failure mode is silence, and silence is
 * indistinguishable from "nothing is wrong".
 *
 * Semantics chosen deliberately:
 *
 *   - Transports run concurrently, so a slow one cannot delay the others.
 *   - The send SUCCEEDS if at least one transport succeeds. Escalating to the
 *     deadman's switch because a secondary channel is down would cry wolf while
 *     the operator is, in fact, being reached.
 *   - It FAILS only when every transport fails — that is genuine undeliverability.
 *   - A PARTIAL failure is still recorded as an Event, not swallowed. Without
 *     that, a broken secondary channel stays broken indefinitely because the
 *     working one masks it, and it is discovered only when the primary also
 *     fails.
 */
export class MultiNotifier implements Notifier {
    readonly name: string
    readonly targets: Notifier[]

    constructor(targets: Notifier[]) {
        if (targets.length === 0) {
            throw new Error('MultiNotifier requires at least one transport')
        }
        this.targets = targets
        this.name = targets.map((t) => t.name).join('+')
    }

    async send(n: Notification): Promise<void> {
        const results = await Promise.allSettled(this.targets.map((t) => t.send(n)))

        const failures: { transport: string; message: string }[] = []

        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                const transport = this.targets[i].name
                const message = String((r.reason as any)?.message ?? r.reason)
                failures.push({ transport, message })
                log.error('[notifier] transport failed', { transport, ruleId: n.ruleId, message })
            }
        })

        for (const f of failures) {
            // Durable record so a degraded transport is visible after the fact
            // and can be alerted on by the notifier_transport_failing rule.
            await prisma.event
                .create({
                    data: {
                        source: 'notifier',
                        kind: 'notify_transport_failed',
                        detail: `${f.transport}: ${f.message}`.slice(0, 500),
                        context: { transport: f.transport, ruleId: n.ruleId },
                    },
                })
                .catch((e) => log.error('[notifier] could not record failure event', { message: String(e?.message ?? e) }))
        }

        if (failures.length === this.targets.length) {
            throw new Error(
                `all ${this.targets.length} transport(s) failed: ` +
                    failures.map((f) => `${f.transport} (${f.message})`).join('; '),
            )
        }
    }
}
