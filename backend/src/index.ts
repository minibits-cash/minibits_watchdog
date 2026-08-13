import 'dotenv/config'
import { config, startupBanner } from './config'
import { buildApp } from './app'
import { startCollector, stopCollector } from './collector/collector'
import { log } from './services/logService'
import prisma from './utils/prismaClient'
import { setNotifier, withRedaction, Notifier } from './alerts/notifier'
import { NtfyNotifier } from './alerts/ntfyNotifier'
import { EmailNotifier } from './alerts/emailNotifier'
import { MultiNotifier } from './alerts/multiNotifier'
import { pingHeartbeat } from './services/heartbeat'

process.stderr.write(startupBanner())

// Assemble whatever transports are configured. With none, the LogNotifier stays
// in place: alerts still fire and are recorded, they just do not leave the
// machine — and the startup banner warns, so that cannot be mistaken for
// working delivery.
const transports: Notifier[] = []

// Redaction is applied per transport here, the single place transports are
// constructed — so a transport added later cannot quietly skip the policy.
if (config.notifiers.ntfy) {
    const ntfy = new NtfyNotifier()
    transports.push(config.notifiers.redact.ntfy ? withRedaction(ntfy) : ntfy)
}

if (config.notifiers.email) {
    const email = new EmailNotifier()
    transports.push(config.notifiers.redact.email ? withRedaction(email) : email)
}

if (transports.length === 1) {
    setNotifier(transports[0])
} else if (transports.length > 1) {
    setNotifier(new MultiNotifier(transports))
}

const app = await buildApp()

app.listen(
    {
        // Loopback only — the dashboard has no auth and is reached over an SSH
        // tunnel. See SPEC.md §9.
        host: config.server.host,
        port: config.server.port,
        listenTextResolver: (address) => `Minibits Watchdog API ready at: ${address}`,
    },
    (err: Error | null) => {
        if (err) {
            console.error(err)
            process.exit(1)
        }
        startCollector()
    },
)

async function shutdown(signal: string) {
    log.info(`[shutdown] received ${signal}`)
    stopCollector()
    try {
        await app.close()
        await prisma.$disconnect()
    } catch (e: any) {
        log.error('[shutdown] error during shutdown', { message: String(e?.message ?? e) })
    }
    process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

/**
 * Announce our own death where it is still possible to do so.
 *
 * This covers only crashes Node can surface — a SIGKILL, an OOM kill or a host
 * failure produces nothing. Those are caught solely by the absence of
 * WATCHDOG_HEARTBEAT_OK, which is why the absence rule, not these handlers, is
 * the actual deadman's switch.
 */
process.on('uncaughtException', (err) => {
    void pingHeartbeat(false, `uncaught exception: ${err.message}`, { stack: err.stack })
    log.error('[fatal] uncaught exception', { message: err.message, stack: err.stack })
    process.exit(1)
})

process.on('unhandledRejection', (reason: any) => {
    const message = String(reason?.message ?? reason)
    void pingHeartbeat(false, `unhandled rejection: ${message}`)
    log.error('[fatal] unhandled rejection', { message })
    process.exit(1)
})
