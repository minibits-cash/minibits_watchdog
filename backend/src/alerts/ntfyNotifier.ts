import { config } from '../config'
import { log } from '../services/logService'
import { Notification, Notifier } from './notifier'
import type { Severity } from '@prisma/client'

/**
 * ntfy transport. See SPEC.md §8.
 *
 * Chosen over reusing the FCM path in minibits_server because that sends
 * NIP-04-encrypted data-only messages the Minibits wallet decrypts — alerting
 * the operator through it would need a wallet change and an app release.
 *
 * ntfy is external to the node and the mint, which satisfies the constraint that
 * delivery must not depend on the systems being monitored.
 */

const PRIORITY: Record<Severity, string> = {
    CRITICAL: '5', // urgent — bypasses do-not-disturb on most clients
    WARNING: '4', // high
    INFO: '3', // default
}

const TAGS: Record<Severity, string> = {
    CRITICAL: 'rotating_light',
    WARNING: 'warning',
    INFO: 'information_source',
}

/**
 * ntfy carries title, priority and tags as HTTP headers, which must be
 * single-line ASCII. Amounts are formatted with thousands separators and rule
 * detail is free text, so anything outside that range is transliterated rather
 * than risking a rejected request or a mangled header.
 */
function asciiHeader(value: string, maxLength = 200): string {
    return value
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[^\x20-\x7E]/g, '?')
        .slice(0, maxLength)
        .trim()
}

export class NtfyNotifier implements Notifier {
    readonly name = 'ntfy'

    private readonly endpoint: string

    constructor() {
        const base = config.ntfy.url.replace(/\/+$/, '')
        this.endpoint = `${base}/${config.ntfy.topic}`
    }

    async send(n: Notification): Promise<void> {
        const severity: Severity = n.resolved ? 'INFO' : n.severity

        const headers: Record<string, string> = {
            Title: asciiHeader(n.resolved ? `RESOLVED: ${n.title}` : n.title),
            Priority: n.resolved ? '3' : PRIORITY[severity],
            Tags: n.resolved ? 'white_check_mark' : TAGS[severity],
        }

        if (config.ntfy.token) {
            headers.Authorization = `Bearer ${config.ntfy.token}`
        }

        const body = [
            n.detail ?? '',
            '',
            `rule: ${n.ruleId}`,
            `subject: ${n.dedupeKey}`,
        ]
            .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
            .join('\n')

        const res = await fetch(this.endpoint, {
            method: 'POST',
            headers,
            body,
            // Bounded so a hung ntfy host cannot stall the collector tick.
            signal: AbortSignal.timeout(10_000),
        })

        if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error(`ntfy responded ${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
        }

        log.debug('[ntfy] sent', { ruleId: n.ruleId, severity, resolved: n.resolved })
    }
}

