#!/usr/bin/env node
/**
 * Backfill `mintOnchain` into historical reconciliations, then recompute the
 * derived chain.
 *
 * WHY THIS EXISTS
 *
 * Adding the mint's on-chain wallet to the reserve identity changed what
 * `Own capital` means. Rows written before the change carry mintOnchain = 0, so
 * the first row written after it steps by the whole balance — and that step is
 * indistinguishable from unexplained drift.
 *
 * The honest fix is not to suppress the step but to remove it: the on-chain
 * balance at any past moment is reconstructible, because every deposit and
 * withdrawal carries a timestamp. SPEC §3.5 is explicit that derived values live
 * downstream of raw ones precisely so a formula change can be repaired across
 * existing history instead of leaving a scar in the series.
 *
 * NOT a routine operation. Run once after the identity changes.
 *
 *   node scripts/backfill-onchain.mjs [--apply]
 *
 * Without --apply it reports what would change and writes nothing.
 */
import 'dotenv/config'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'

const APPLY = process.argv.includes('--apply')
const prisma = new PrismaClient()
const mint = new pg.Client({ connectionString: process.env.MINT_DATABASE_URL })

const sat = (msat) => (msat / 1000n).toLocaleString('en-US')

try {
    await mint.connect()
    await mint.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')

    const known = await prisma.mintOnchainQuote.findMany({ select: { quoteId: true } })
    const ids = known.map((k) => k.quoteId)
    if (ids.length === 0) {
        console.log('No on-chain quotes known yet — run the collector first.')
        process.exit(0)
    }

    // Every on-chain movement, with the time it happened.
    const deposits = await mint.query(
        'SELECT timestamp AS ts, amount FROM mint_quote_payments WHERE quote_id = ANY($1)',
        [ids],
    )
    const withdrawals = await mint.query(
        `SELECT completed_at AS ts, (payment_amount + payment_fee) AS amount
         FROM completed_operations
         WHERE operation_kind = 'melt' AND payment_method = 'onchain'`,
    )

    const events = [
        ...deposits.rows.map((r) => ({ ts: Number(r.ts), delta: BigInt(r.amount) * 1000n })),
        ...withdrawals.rows.map((r) => ({ ts: Number(r.ts), delta: -BigInt(r.amount) * 1000n })),
    ].sort((a, b) => a.ts - b.ts)

    console.log(`on-chain events: ${deposits.rowCount} deposits, ${withdrawals.rowCount} withdrawals`)
    for (const e of events) {
        console.log(`  ${new Date(e.ts * 1000).toISOString()}  ${e.delta > 0n ? '+' : ''}${sat(e.delta)}`)
    }

    /** Balance as of a moment: every event at or before it. */
    const balanceAt = (date) => {
        const t = Math.floor(date.getTime() / 1000)
        return events.reduce((acc, e) => (e.ts <= t ? acc + e.delta : acc), 0n)
    }

    const rows = await prisma.reconciliation.findMany({
        orderBy: { id: 'asc' },
        include: { observation: { select: { observedAt: true } } },
    })

    console.log(`\nreconciliations: ${rows.length}`)

    let changed = 0
    let prev = null

    for (const row of rows) {
        const mintOnchain = balanceAt(row.observation.observedAt)

        // Own capital is fully determined by the stored raw terms, so it is
        // recomputed rather than adjusted — no drift from patching in place.
        const ownCapital =
            row.totalNodeBalance + row.coldStorage + mintOnchain - row.mintBalance + row.proofsPending

        const deltaOwnCapital = prev ? ownCapital - prev.ownCapital : null
        const deltaUnclaimed = prev ? row.unclaimed - prev.unclaimed : null
        const deltaColdStorage = prev ? row.coldStorage - prev.coldStorage : null
        const deltaMintFees = prev ? (row.mintFeesCollected ?? 0n) - prev.mintFeesCollected : null
        const remainingDelta =
            deltaOwnCapital === null
                ? null
                : deltaOwnCapital - deltaUnclaimed - deltaColdStorage - deltaMintFees

        const differs =
            row.mintOnchain !== mintOnchain ||
            row.ownCapital !== ownCapital ||
            row.remainingDelta !== remainingDelta

        if (differs) {
            changed++
            if (APPLY) {
                await prisma.reconciliation.update({
                    where: { id: row.id },
                    data: {
                        mintOnchain,
                        ownCapital,
                        deltaOwnCapital,
                        deltaUnclaimed,
                        deltaColdStorage,
                        deltaMintFees,
                        remainingDelta,
                    },
                })
            }
        }

        // Carry every field the next row's deltas are computed against — not
        // just ownCapital, which was the original slip here.
        prev = {
            ownCapital,
            unclaimed: row.unclaimed,
            coldStorage: row.coldStorage,
            mintFeesCollected: row.mintFeesCollected ?? 0n,
        }
    }

    console.log(`\nrows needing correction: ${changed}`)
    console.log(APPLY ? 'APPLIED.' : 'Dry run — re-run with --apply to write.')
} catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
} finally {
    await mint.end().catch(() => {})
    await prisma.$disconnect()
}
