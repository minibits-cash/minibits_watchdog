import pg from 'pg'
import { config } from '../../config'
import { log } from '../../services/logService'

/**
 * Read-only connection pool for the CDK mint database.
 *
 * The role has SELECT only (verified: no INSERT/UPDATE/DELETE on any table), and
 * every session additionally declares itself read-only. The grants are the
 * actual boundary — the session setting is a guardrail, since a non-superuser
 * can turn it off for its own session.
 *
 * Small pool: the collector runs one tick at a time against a shared production
 * cluster, so there is nothing to gain from holding connections open in bulk.
 */
let pool: pg.Pool | undefined

export function getMintPool(): pg.Pool {
    if (!pool) {
        pool = new pg.Pool({
            connectionString: config.mintDatabaseUrl,
            max: 2,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
            // Belt and braces: the role already sets this, but an instance
            // pointed at a differently-configured role must still be read-only.
            options: '-c default_transaction_read_only=on',
        })

        pool.on('error', (err) => {
            log.error('[mintClient] idle client error', { message: err.message })
        })
    }
    return pool
}

export async function closeMintPool(): Promise<void> {
    if (pool) {
        await pool.end()
        pool = undefined
    }
}
