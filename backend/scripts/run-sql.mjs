#!/usr/bin/env node
/**
 * Run a single-statement .sql file against a connection string and print the
 * result as a table.
 *
 * Exists because there is no psql on this machine, and because the mint
 * connection must go through the app's own read-only role — running these
 * queries the same way the collector will run them means we are verifying the
 * real path, not an equivalent one.
 *
 * Usage:
 *   node scripts/run-sql.mjs <file.sql> [ENV_VAR_WITH_CONNECTION_STRING]
 *
 * Defaults to MINT_DATABASE_URL.
 *
 * Only files containing a single statement work here (the *-beekeeper.sql and
 * verify-*.sql ones). The psql variant uses backslash meta-commands and will not.
 */
import { readFileSync } from 'node:fs'
import 'dotenv/config'
import pg from 'pg'

const [, , file, envVar = 'MINT_DATABASE_URL'] = process.argv

if (!file) {
    console.error('usage: node scripts/run-sql.mjs <file.sql> [ENV_VAR]')
    process.exit(1)
}

const connectionString = process.env[envVar]
if (!connectionString) {
    console.error(`FATAL: ${envVar} is not set`)
    process.exit(1)
}

const sql = readFileSync(file, 'utf8')

if (/^\s*\\/m.test(sql)) {
    console.error(
        `FATAL: ${file} contains psql meta-commands (\\echo, \\pset). Use the -beekeeper variant.`,
    )
    process.exit(1)
}

// Read-only session: this script is only ever used for inspection, and the
// mint database is production data.
const client = new pg.Client({ connectionString, statement_timeout: 300_000 })

try {
    await client.connect()
    // Session-scoped, not SET TRANSACTION: node-postgres autocommits each query,
    // so a transaction-scoped setting would lapse immediately.
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')

    const started = Date.now()
    const res = await client.query(sql)
    const elapsed = Date.now() - started

    // A file with several statements yields an array of results — print them
    // all, since the EXPLAIN scripts depend on seeing every plan.
    const results = Array.isArray(res) ? res : [res]
    let total = 0

    results.forEach((result, i) => {
        const rows = result.rows ?? []
        total += rows.length

        if (results.length > 1) console.log(`\n--- statement ${i + 1} ---`)

        if (rows.length === 0) {
            console.log('(no rows)')
        } else if (Object.keys(rows[0]).length === 1) {
            // Single-column reports print as plain lines so they stay copy-pasteable.
            const key = Object.keys(rows[0])[0]
            for (const r of rows) console.log(r[key])
        } else {
            console.table(rows)
        }
    })

    console.error(`\n-- ${total} rows across ${results.length} statement(s) in ${elapsed}ms`)
} catch (e) {
    console.error(`QUERY FAILED: ${e.message}`)
    process.exitCode = 1
} finally {
    await client.end().catch(() => {})
}
