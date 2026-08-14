/**
 * Reset gathered data and/or rule configuration.
 *
 *   yarn reset:data                      # dry run — reports, writes nothing
 *   yarn reset:data --yes                # clear observations, KEEP rule tuning
 *   yarn reset:data --yes --rules-only   # reseed rule defaults, KEEP observations
 *   yarn reset:data --yes --all          # clear both
 *
 * ── Why the two are separable ────────────────────────────────────────────────
 *
 * Observations are measurements; `RuleConfig` is operator tuning. They fail
 * independently and are fixed independently: a corrupted series needs the data
 * cleared, whereas a code default you have changed needs the config reseeded —
 * because `loadConfigs` only ever CREATES missing rows, so editing a default in
 * source has no effect on a database that already has the row.
 *
 * Reseeding calls the engine's own `loadConfigs`, so what lands in the database
 * is exactly what the app would seed. A reimplementation here would be free to
 * drift from it, and would do so silently.
 *
 * ── Why LedgerWatermark and MintOnchainQuote move together ───────────────────
 *
 * `MintOnchainQuote` caches which mint quotes were settled on-chain; discovery
 * is watermarked in `LedgerWatermark` by `created_time` and only moves forward.
 * Clearing the cache while keeping the watermark would mean the scanned window
 * is never revisited — every historical on-chain quote forgotten permanently,
 * and on-chain reserves under-reporting for the life of the deployment, quietly,
 * because a smaller number looks plausible. Truncated as a pair, never alone.
 *
 * ── Note on alerts ───────────────────────────────────────────────────────────
 *
 * Clearing `AlertState` means any condition still true fires — and notifies —
 * again on the next tick. Correct, but worth expecting.
 */
import 'dotenv/config'
import prisma from '../src/utils/prismaClient'
import { loadConfigs } from '../src/alerts/engine'
import { allRules } from '../src/rules'

const args = process.argv.slice(2)
const APPLY = args.includes('--yes')
const ALL = args.includes('--all')
const RULES_ONLY = args.includes('--rules-only')

if (ALL && RULES_ONLY) {
    console.error('--all and --rules-only are contradictory: --all already includes the rules.')
    process.exit(1)
}

/** Truncated as one statement: atomic, and it resets the id sequences too. */
const DATA_TABLES = [
    'Observation', // cascades to LndSnapshot, MintSnapshot, Reconciliation
    'LndSnapshot',
    'MintSnapshot',
    'Reconciliation',
    'AlertState', // cascades to AlertEvent
    'AlertEvent',
    'Event',
    'LedgerWatermark', // paired with MintOnchainQuote — see header
    'MintOnchainQuote',
]

const maskedUrl = (process.env.DATABASE_URL ?? '').replace(/:[^:@/]*@/, ':***@')

async function countRows(table: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${table}"`,
    )
    return Number(rows[0]?.n ?? 0)
}

async function main() {
    const clearData = !RULES_ONLY
    const clearRules = ALL || RULES_ONLY

    const tables = [...(clearData ? DATA_TABLES : []), ...(clearRules ? ['RuleConfig'] : [])]

    console.log(`\ntarget database: ${maskedUrl}\n`)

    let total = 0
    for (const t of tables) {
        const n = await countRows(t)
        total += n
        console.log(`  ${t.padEnd(20)} ${String(n).padStart(8)}`)
    }
    console.log(`  ${'-'.repeat(20)} ${'-'.repeat(8)}`)
    console.log(`  ${'total'.padEnd(20)} ${String(total).padStart(8)}\n`)

    if (!clearRules) {
        console.log(`  RuleConfig KEPT (${await countRows('RuleConfig')} rows of tuning).`)
        console.log('  Use --all to clear it too, or --rules-only to reseed just the rules.\n')
    }
    if (!clearData) {
        console.log(`  Observations KEPT (${await countRows('Observation')} rows). Rules only.\n`)
    }

    if (!APPLY) {
        console.log('Dry run — nothing deleted. Re-run with --yes to apply.')
        if (clearData) {
            console.log('Stop the collector first, or a tick mid-truncate repopulates part of it.')
        }
        console.log()
        return
    }

    if (tables.length > 0) {
        const list = tables.map((t) => `"${t}"`).join(', ')
        await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
        console.log(`Deleted ${total} rows across ${tables.length} tables. Sequences reset.`)
    }

    if (clearRules) {
        // The engine's own seeding path, so this cannot drift from what the app does.
        const seeded = await loadConfigs()
        console.log(`\nReseeded ${seeded.size} rule configs from code defaults:\n`)
        for (const rule of allRules) {
            const c = seeded.get(rule.id)
            if (!c) continue
            console.log(
                `  ${rule.id.padEnd(28)}${c.severity.padEnd(9)}` +
                    `for=${c.forEvaluations} clear=${c.clearEvaluations} ` +
                    `cooldown=${c.cooldownSeconds}s notifyOnResolve=${c.notifyOnResolve}`,
            )
        }
    }

    console.log(
        clearData
            ? '\nThe next collector tick starts a fresh series.\n'
            : '\nObservations untouched; new tuning applies on the next tick.\n',
    )
}

main()
    .catch((e) => {
        console.error('FAILED:', e?.message ?? e)
        process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
