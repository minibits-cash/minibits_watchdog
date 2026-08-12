import 'dotenv/config'

/**
 * Fail-fast configuration. Every required value is validated at startup rather
 * than at first use — a monitoring tool that half-starts and silently collects
 * nothing is worse than one that refuses to boot.
 */

function required(name: string): string {
    const v = process.env[name]
    if (!v || v.trim() === '') {
        console.error(`FATAL: Missing ${name} environment variable`)
        process.exit(1)
    }
    return v.trim()
}

function optional(name: string, fallback = ''): string {
    return (process.env[name] ?? fallback).trim()
}

function intVar(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = parseInt(raw, 10)
    if (Number.isNaN(n)) {
        console.error(`FATAL: ${name} must be an integer, got "${raw}"`)
        process.exit(1)
    }
    return n
}

/**
 * Which sources this instance collects. Defaults to all of them.
 *
 * A source's credentials are required only when it is enabled, so a dev machine
 * can run with just the mint. Disabling is deliberately explicit rather than
 * inferred from missing config: an accidentally absent macaroon in production
 * must fail loudly, not silently degrade into "that source is not monitored" —
 * which is the failure mode this whole tool exists to prevent.
 */
const enabledSources = new Set(
    optional('ENABLED_SOURCES', 'lnd,mint')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
)

const lndEnabled = enabledSources.has('lnd')
const mintEnabled = enabledSources.has('mint')

function requiredIf(enabled: boolean, name: string): string {
    return enabled ? required(name) : optional(name)
}

/**
 * Which notification transports are active. Same rationale as ENABLED_SOURCES:
 * a transport's credentials are required only when it is switched on, and
 * switching one off must be deliberate rather than the accidental result of a
 * missing variable.
 */
const enabledNotifiers = new Set(
    optional('ENABLED_NOTIFIERS', '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
)

const ntfyEnabled = enabledNotifiers.has('ntfy')
const emailEnabled = enabledNotifiers.has('email')

export const config = {
    databaseUrl: required('DATABASE_URL'),
    mintDatabaseUrl: requiredIf(mintEnabled, 'MINT_DATABASE_URL'),
    backingUnit: optional('BACKING_UNIT', 'sat'),

    /**
     * Operator-declared reserves held outside the Lightning node, in sat.
     *
     * Added to the asset side so moving funds to cold storage does not read as a
     * shortfall. Kept separate from the LND figures rather than folded into
     * them, so what was measured stays distinguishable from what was declared.
     *
     * Because it is manual, the WINDOW between moving coins and updating this
     * value is a real, undeclared outflow — and the watchdog will alert on it.
     * That is intended: an undeclared movement of funds off the node is exactly
     * what this tool exists to notice.
     */
    coldStorageReservesSat: intVar('COLD_STORAGE_RESERVES', 0),


    sources: {
        lnd: lndEnabled,
        mint: mintEnabled,
    },

    lnd: {
        host: requiredIf(lndEnabled, 'LND_HOST'),
        port: intVar('LND_PORT', 10009),
        macaroon: requiredIf(lndEnabled, 'LND_READONLY_MACAROON'),
        cert: requiredIf(lndEnabled, 'LND_TLS_CERT'),
    },

    collect: {
        intervalMs: intVar('COLLECT_INTERVAL_MS', 300_000),
        sourceTimeoutMs: intVar('COLLECT_SOURCE_TIMEOUT_MS', 20_000),
    },

    notifiers: {
        ntfy: ntfyEnabled,
        email: emailEnabled,
        /**
         * Strip numeric amounts from outbound alerts.
         *
         * Alert text carries reserve figures, channel balances and pending
         * totals. When the transport is a third party — a public ntfy.sh topic,
         * or a mailbox at a provider who can read it — this keeps the alert
         * actionable ("reserve drift, check the dashboard") without publishing
         * the mint's finances. Severity, rule and subject are preserved, so
         * urgency still comes through.
         */
        redactAmounts: optional('NOTIFY_REDACT_AMOUNTS', 'false').toLowerCase() === 'true',
    },

    ntfy: {
        url: optional('NTFY_URL', 'https://ntfy.sh'),
        topic: requiredIf(ntfyEnabled, 'NTFY_TOPIC'),
        token: optional('NTFY_TOKEN'),
    },

    email: {
        host: requiredIf(emailEnabled, 'SMTP_HOST'),
        port: intVar('SMTP_PORT', 587),
        secure: optional('SMTP_SECURE', 'false').toLowerCase() === 'true',
        user: optional('SMTP_USER'),
        pass: optional('SMTP_PASS'),
        from: requiredIf(emailEnabled, 'EMAIL_FROM'),
        to: requiredIf(emailEnabled, 'EMAIL_TO'),
    },

    heartbeatUrl: optional('HEARTBEAT_URL'),

    server: {
        host: optional('HOST', '127.0.0.1'),
        port: intVar('PORT', 3005),
        corsOrigin: optional('CORS_ORIGIN', 'http://localhost:3006'),
    },

    logLevel: optional('LOG_LEVEL', 'info'),
} as const

function maskUrl(url: string): string {
    return url.replace(/:[^:@/]*@/, ':***@')
}

export function startupBanner(): string {
    const warnings: string[] = []

    if (!config.notifiers.ntfy && !config.notifiers.email) {
        warnings.push('ENABLED_NOTIFIERS is empty — alerts fire and are recorded, but leave the machine nowhere.')
    }
    if (!config.notifiers.redactAmounts && (config.notifiers.email || config.notifiers.ntfy)) {
        warnings.push(
            'NOTIFY_REDACT_AMOUNTS is off — alerts carry reserve figures and balances to third-party transports.',
        )
    }
    if (!config.heartbeatUrl) {
        warnings.push(
            'HEARTBEAT_URL is empty — relying on log markers alone. The external log analyser MUST alert on ' +
                'the ABSENCE of WATCHDOG_HEARTBEAT_OK; a crashed watchdog emits no ERROR line at all.',
        )
    }
    if (config.server.host !== '127.0.0.1' && config.server.host !== 'localhost') {
        warnings.push(`HOST is ${config.server.host}, not loopback — the dashboard has no auth.`)
    }
    if (!config.sources.lnd) {
        warnings.push('LND source is DISABLED — node balances are not being monitored.')
    }
    if (!config.sources.mint) {
        warnings.push('Mint source is DISABLED — mint reserves are not being monitored.')
    }

    return [
        '',
        '=== Minibits Watchdog ===========================',
        `  database         : ${maskUrl(config.databaseUrl)}`,
        `  sources          : ${[
            config.sources.lnd ? 'lnd' : 'lnd(off)',
            config.sources.mint ? 'mint' : 'mint(off)',
        ].join(', ')}`,
        `  mint database    : ${config.mintDatabaseUrl ? `${maskUrl(config.mintDatabaseUrl)} (read-only)` : '(not configured)'}`,
        `  backing unit     : ${config.backingUnit}`,
        `  lnd              : ${config.sources.lnd ? `${config.lnd.host}:${config.lnd.port} (readonly macaroon)` : '(disabled)'}`,
        `  collect interval : ${config.collect.intervalMs / 1000}s`,
        `  notifiers        : ${
            [config.notifiers.ntfy ? 'ntfy' : null, config.notifiers.email ? 'email' : null]
                .filter(Boolean)
                .join(', ') || '(none — log only)'
        }${config.notifiers.redactAmounts ? '  [amounts redacted]' : ''}`,
        `  ntfy             : ${config.notifiers.ntfy ? `${config.ntfy.url}/${config.ntfy.topic.slice(0, 6)}…` : '(disabled)'}`,
        `  email            : ${config.notifiers.email ? `${config.email.host}:${config.email.port} → ${config.email.to}` : '(disabled)'}`,
        `  heartbeat        : ${config.heartbeatUrl || '(not configured)'}`,
        `  listen           : ${config.server.host}:${config.server.port}`,
        `  log level        : ${config.logLevel}`,
        '=================================================',
        ...warnings.map((w) => `  WARNING: ${w}`),
        '',
    ].join('\n')
}
