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

/**
 * The mint's management gRPC listener, which since CDK exposed `WalletService`
 * can report the BDK on-chain wallet balance directly.
 *
 * Gated on the host being set rather than on ENABLED_SOURCES, because it is not
 * a source in its own right — it is a second reading within the mint source, and
 * an instance pointed at an older mintd has no endpoint to call. The startup
 * banner states which basis is in use either way, and warns when it is the
 * ledger estimate, so "not configured" cannot pass unnoticed.
 */
const mintRpcHost = optional('MINT_RPC_HOST')
const mintRpcEnabled = mintEnabled && mintRpcHost !== ''

function requiredIf(enabled: boolean, name: string): string {
    return enabled ? required(name) : optional(name)
}

function boolVar(name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    return raw.trim().toLowerCase() === 'true'
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

    /**
     * Issued ecash the operator knows can never be redeemed — typically promises
     * stranded by a migration to a mint implementation that cannot spend them.
     *
     * `issued − redeemed` counts them as a liability the mint will never actually
     * settle, which understates own capital by a fixed amount forever.
     *
     * Added to own capital rather than deducted from `mintBalance`, deliberately:
     * `mintBalance` stays exactly what the mint database says, so a measurement
     * and a declaration never get blended into one number. The arithmetic is
     * identical either way — `−(mintBalance − U)` is `−mintBalance + U` — so the
     * only thing at stake is which figure remains audit-able against the mint,
     * and it should be the measured one.
     *
     * Like cold storage, changing it is a DECLARED movement and is excluded from
     * remaining delta, so correcting the figure raises no false drift alert.
     */
    provablyUnspendableEcashSat: intVar('PROVABLY_UNSPENDABLE_ECASH', 0),


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

    /**
     * CDK's mint management gRPC endpoint, read for the BDK wallet balance.
     *
     * TLS is optional because cdk-mintd's own default is `allow_insecure` on
     * loopback, and the realistic deployment is either same-host loopback or an
     * SSH tunnel — both of which already carry the transport security. When
     * `tlsCa` is set, mutual TLS is used and all three PEM paths are required:
     * cdk-mintd's TLS mode authenticates the client, so a CA without a client
     * keypair would simply be rejected at handshake.
     */
    mintRpc: {
        enabled: mintRpcEnabled,
        host: mintRpcHost,
        port: intVar('MINT_RPC_PORT', 8086),
        tlsCaPath: optional('MINT_RPC_TLS_CA'),
        tlsClientCertPath: optional('MINT_RPC_TLS_CLIENT_CERT'),
        tlsClientKeyPath: optional('MINT_RPC_TLS_CLIENT_KEY'),
        /**
         * Deliberately well inside COLLECT_SOURCE_TIMEOUT_MS. The wallet read is
         * one call inside the mint source; letting it consume the whole source
         * budget would take the database figures down with it, and those stay
         * useful even when the RPC is unreachable.
         */
        timeoutMs: intVar('MINT_RPC_TIMEOUT_MS', 5_000),
        /**
         * Sent as `x-cdk-protocol-version`. cdk-mintd compares it by exact
         * string and refuses every request without it, so this is not advisory.
         * See callMetadata() in mintRpcClient.ts for why it is an env var.
         */
        protocolVersion: optional('MINT_RPC_PROTOCOL_VERSION', '1.0.0'),
    },

    collect: {
        intervalMs: intVar('COLLECT_INTERVAL_MS', 300_000),
        sourceTimeoutMs: intVar('COLLECT_SOURCE_TIMEOUT_MS', 20_000),
    },

    notifiers: {
        ntfy: ntfyEnabled,
        email: emailEnabled,
        /**
         * Strip numeric amounts from outbound alerts, per transport.
         *
         * Alert text carries reserve figures, channel balances and pending
         * totals. When the transport is a third party — a public ntfy.sh topic,
         * or a mailbox at a provider who can read it — this keeps the alert
         * actionable ("reserve drift, check the dashboard") without publishing
         * the mint's finances. Severity, rule and subject are preserved, so
         * urgency still comes through.
         *
         * Set per transport because the exposures genuinely differ: an
         * unauthenticated public topic is readable by anyone who guesses it,
         * whereas a mailbox on your own domain is not.
         *
         * Both default to TRUE. Disclosure should be a deliberate act, so an
         * unset or misspelled variable errs toward privacy rather than quietly
         * publishing the mint's finances.
         */
        redact: {
            ntfy: boolVar('NTFY_REDACT_AMOUNTS', true),
            email: boolVar('EMAIL_REDACT_AMOUNTS', true),
        },
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

// A half-specified TLS setup fails at the first gRPC handshake, minutes after
// startup and inside a source that is designed to survive its own failures — so
// it would surface as "wallet RPC unreachable" rather than as the configuration
// error it is. Checked here instead, where the remedy is unambiguous.
{
    const tls = [
        ['MINT_RPC_TLS_CA', config.mintRpc.tlsCaPath],
        ['MINT_RPC_TLS_CLIENT_CERT', config.mintRpc.tlsClientCertPath],
        ['MINT_RPC_TLS_CLIENT_KEY', config.mintRpc.tlsClientKeyPath],
    ] as const
    const set = tls.filter(([, v]) => v !== '')
    if (set.length > 0 && set.length < tls.length) {
        console.error(
            `FATAL: mint RPC TLS is partially configured. Set all of ` +
                `${tls.map(([n]) => n).join(', ')}, or none of them for an insecure ` +
                `connection (appropriate on loopback or through an SSH tunnel).`,
        )
        process.exit(1)
    }
    if (set.length > 0 && !config.mintRpc.enabled) {
        console.error(
            'FATAL: mint RPC TLS is configured but MINT_RPC_HOST is empty, so the endpoint ' +
                'would never be contacted. Set MINT_RPC_HOST or clear the TLS variables.',
        )
        process.exit(1)
    }
}

function maskUrl(url: string): string {
    return url.replace(/:[^:@/]*@/, ':***@')
}

export function startupBanner(): string {
    const warnings: string[] = []

    if (!config.notifiers.ntfy && !config.notifiers.email) {
        warnings.push('ENABLED_NOTIFIERS is empty — alerts fire and are recorded, but leave the machine nowhere.')
    }
    const unredacted = [
        config.notifiers.ntfy && !config.notifiers.redact.ntfy ? 'ntfy' : null,
        config.notifiers.email && !config.notifiers.redact.email ? 'email' : null,
    ].filter(Boolean)
    if (unredacted.length > 0) {
        warnings.push(
            `Amounts are NOT redacted for: ${unredacted.join(', ')} — those alerts carry reserve figures and balances.`,
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
    if (config.sources.mint && !config.mintRpc.enabled) {
        warnings.push(
            'MINT_RPC_HOST is empty — mint on-chain reserves are the LEDGER ESTIMATE, derived from ' +
                'the same mint database this tool audits. It cannot detect coins leaving the BDK wallet ' +
                'by any route CDK did not book, which is the outflow most worth catching. Point it at ' +
                "cdk-mintd's management RPC to measure the wallet directly.",
        )
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
        `  mint rpc         : ${
            config.mintRpc.enabled
                ? `${config.mintRpc.host}:${config.mintRpc.port} (${
                      config.mintRpc.tlsCaPath ? 'mutual TLS' : 'INSECURE — loopback/tunnel only'
                  })`
                : '(not configured)'
        }`,
        `  mint on-chain    : ${config.mintRpc.enabled ? 'BDK wallet balance (measured)' : 'CDK ledger estimate (interim)'}`,
        `  collect interval : ${config.collect.intervalMs / 1000}s`,
        `  notifiers        : ${
            [config.notifiers.ntfy ? 'ntfy' : null, config.notifiers.email ? 'email' : null]
                .filter(Boolean)
                .join(', ') || '(none — log only)'
        }`,
        `  redact amounts   : ${
            [
                config.notifiers.ntfy ? `ntfy=${config.notifiers.redact.ntfy}` : null,
                config.notifiers.email ? `email=${config.notifiers.redact.email}` : null,
            ]
                .filter(Boolean)
                .join('  ') || '(no transports)'
        }`,
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
