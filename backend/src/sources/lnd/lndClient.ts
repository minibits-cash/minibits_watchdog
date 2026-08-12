import { LndClient as PolarLndClient } from '@lightningpolar/lnd-api'
import { config } from '../../config'

/**
 * Read-only LND client.
 *
 * Uses readonly.macaroon: the watchdog never writes to LND, so a compromised
 * watchdog cannot move funds (SPEC.md §1).
 */
let client: ReturnType<typeof PolarLndClient.create> | undefined

export function getLndClient() {
    if (!client) {
        client = PolarLndClient.create({
            socket: `${config.lnd.host}:${config.lnd.port}`,
            macaroon: config.lnd.macaroon,
            cert: config.lnd.cert,
        })
    }
    return client
}
