import { config } from '../config'
import { log } from './logService'

/**
 * Deadman's switch. See SPEC.md §8.
 *
 * Silence is the most dangerous state a monitoring tool can be in: a watchdog
 * that has crashed looks exactly like a watchdog with nothing to report.
 *
 * Two independent channels, either or both of which can be used:
 *
 *  1. **Log markers** (always emitted). A single-line JSON record on stdout for
 *     every tick, for an external log collector to match on.
 *  2. **HTTP ping** (when HEARTBEAT_URL is set). healthchecks.io convention —
 *     base URL for success, `<base>/fail` for a problem.
 *
 * ── Why the OK marker matters more than the FAIL marker ──────────────────────
 *
 * A crashed or hung process emits nothing at all. No ERROR line is produced,
 * because no code is running to produce it. Alerting only on WATCHDOG_HEARTBEAT_FAIL
 * therefore catches the failures the watchdog can still report, and misses
 * exactly the one it cannot — its own death.
 *
 * The OK marker exists to be alerted on by its ABSENCE: "no WATCHDOG_HEARTBEAT_OK
 * in the last N minutes" is the rule that actually implements the deadman's switch.
 *
 * ── Why this bypasses the logger ─────────────────────────────────────────────
 *
 * Written straight to stdout rather than through logService, so that raising
 * LOG_LEVEL to warn/error cannot silently suppress the liveness signal. A
 * heartbeat that a configuration change can switch off is not a heartbeat.
 */

export const HEARTBEAT_OK = 'WATCHDOG_HEARTBEAT_OK'
export const HEARTBEAT_FAIL = 'WATCHDOG_HEARTBEAT_FAIL'

export interface HeartbeatContext {
    observationId?: number
    lnd?: string
    mint?: string
    durationMs?: number
    [key: string]: unknown
}

function emitMarker(ok: boolean, detail?: string, context?: HeartbeatContext): void {
    const record = {
        marker: ok ? HEARTBEAT_OK : HEARTBEAT_FAIL,
        ts: new Date().toISOString(),
        ...(detail ? { detail } : {}),
        ...(context ?? {}),
    }

    // Deliberately not logService: level configuration must not be able to
    // suppress this line.
    process.stdout.write(JSON.stringify(record) + '\n')
}

export async function pingHeartbeat(
    ok: boolean,
    detail?: string,
    context?: HeartbeatContext,
): Promise<void> {
    emitMarker(ok, detail, context)

    // Also surface failures through the normal logger, so they appear in
    // context alongside the error that caused them.
    if (!ok) {
        log.error(`${HEARTBEAT_FAIL} ${detail ?? ''}`, context ?? {})
    }

    if (!config.heartbeatUrl) return

    const base = config.heartbeatUrl.replace(/\/+$/, '')
    const url = ok ? base : `${base}/fail`

    try {
        const res = await fetch(url, {
            method: 'POST',
            body: detail ? detail.slice(0, 1000) : undefined,
            signal: AbortSignal.timeout(10_000),
        })

        if (!res.ok) {
            log.warn('[heartbeat] non-OK response', { status: res.status, ok })
        }
    } catch (e: any) {
        // Never rethrow: the heartbeat reports on the tick and must not become a
        // reason for the tick to fail.
        log.warn('[heartbeat] ping failed', { message: String(e?.message ?? e), ok })
    }
}
