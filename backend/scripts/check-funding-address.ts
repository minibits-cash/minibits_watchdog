import 'dotenv/config'
import { config } from '../src/config'
import { listWalletAddresses } from '../src/sources/mint/mintRpcClient'
import { getMintPool } from '../src/sources/mint/mintClient'
import { QUOTE_BY_ADDRESS } from '../src/sources/mint/mintQueries'

/**
 * Pre-flight check before sending operator liquidity to the mint's BDK wallet.
 *
 * Exists because of a real incident: 9,900,000 sat was sent to an address the
 * wallet handed out as "unused", which had in fact been revealed to a user's
 * on-chain mint quote nine days earlier. BDK's notion of unused means "no
 * transaction has paid it" — a revealed-but-unfunded quote address still
 * qualifies — so CDK credited the operator's own money to that user's quote,
 * leaving it claimable as ecash. Recovering it took a mint shutdown and manual
 * SQL against two tables.
 *
 * The check is prevention, not detection, and deliberately so. Once the coins
 * are on-chain, an operator funding a quote address and a user paying their own
 * quote are indistinguishable — no rule can separate them after the fact.
 *
 * Read-only against both the mint database and the wallet RPC.
 */

const address = process.argv[2]

if (!address) {
    console.error('usage: yarn check-funding-address <bitcoin-address>')
    process.exit(2)
}

if (!config.mintRpc.enabled) {
    console.error('MINT_RPC_HOST is not set — the wallet cannot be asked about this address.')
    process.exit(2)
}

const problems: string[] = []
const warnings: string[] = []

// 1. Does this address actually belong to the mint's wallet?
//
// First rather than last on purpose: sending to a mistyped address is an
// unrecoverable total loss, and it is the only failure here with no remedy.
const addrs = await listWalletAddresses()
const mine = addrs.find((a) => a.address === address)

if (!mine) {
    problems.push(
        `NOT a revealed address of the mint's BDK wallet (checked ${addrs.length} addresses). ` +
            `Either it is mistyped, it belongs to a different wallet, or it has not been revealed ` +
            `yet — generate it with cdk-mint-cli get-new-address and re-run.`,
    )
}

// 2. Does a mint quote already own it? This is the incident above.
const pool = getMintPool()
const q = await pool.query(QUOTE_BY_ADDRESS, [[address]])

if (q.rows.length > 0) {
    const ids = (q.rows as any[]).map((r) => r.id)
    const d = await pool.query(
        `SELECT id, amount_paid, amount_issued, created_time FROM mint_quote WHERE id = ANY($1)`,
        [ids],
    )
    for (const r of d.rows as any[]) {
        problems.push(
            `belongs to mint quote ${r.id} (created ${new Date(Number(r.created_time) * 1000).toISOString()}, ` +
                `paid ${r.amount_paid}, issued ${r.amount_issued}). Anything sent here becomes ` +
                `claimable ecash for that quote's holder.`,
        )
    }
}

// 3. Reuse. Not fatal, but it links this payment to whatever touched it before.
if (mine?.used) {
    warnings.push(
        `already used (balance ${mine.balanceMsat / 1000n} sat). Reuse links your funding ` +
            `transaction to the wallet's existing history on-chain.`,
    )
}

if (mine && mine.keychain.toLowerCase().includes('internal')) {
    warnings.push(`on the INTERNAL (change) keychain at index ${mine.derivationIndex}, not the receiving one.`)
}

// Report
console.log(`\naddress   ${address}`)
if (mine) {
    console.log(`wallet    yes — ${mine.keychain} keychain, index ${mine.derivationIndex}, used=${mine.used}`)
} else {
    console.log(`wallet    NO MATCH`)
}
console.log(`quotes    ${q.rows.length} mint quote(s) reference this address`)

for (const w of warnings) console.log(`\n  warning: ${w}`)
for (const p of problems) console.log(`\n  PROBLEM: ${p}`)

console.log(
    problems.length === 0
        ? `\nVERDICT: SAFE TO FUND${warnings.length ? ' (with the warnings above)' : ''}\n`
        : `\nVERDICT: DO NOT FUND\n`,
)

await pool.end()
process.exit(problems.length === 0 ? 0 : 1)
