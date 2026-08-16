/**
 * Read the mint's BDK wallet balance once and print it, alongside the ledger
 * estimate it replaces.
 *
 * Run this BEFORE deploying the switch to the wallet basis. The gap it prints is
 * the one-off step the changeover puts into own capital, and knowing its size in
 * advance is the difference between an expected artifact and a 3am alert.
 *
 * Uses the real collector code path — the same proto resolution, credentials and
 * field extraction the collector will use — so a green result here means the
 * collector will work, not merely that the port is open.
 *
 * Not purely read-only: computing the ledger estimate runs MintSource, which
 * advances the watchdog's own quote-discovery and ledger watermarks exactly as a
 * collection tick does. Harmless — it is the same write — but worth knowing
 * before running it against production.
 *
 *   yarn probe:mint-rpc
 */
import 'dotenv/config'
import { config } from '../src/config'
import { readWalletBalance, closeMintRpcClient } from '../src/sources/mint/mintRpcClient'
import { MintSource } from '../src/sources/mint/mintSource'
import { closeMintPool } from '../src/sources/mint/mintClient'
import { collectOnchainDeposits } from '../src/sources/mint/onchainDeposits'
import { chainInfo } from '../src/sources/chain/bitcoinRpcClient'
import { formatSat } from '../src/utils/money'

if (!config.mintRpc.enabled) {
    console.error(
        '\nMINT_RPC_HOST is not set, so there is nothing to probe.\n\n' +
            "Point it at cdk-mintd's [mint_management_rpc] listener — directly if the\n" +
            'watchdog runs on the mint host, or through an SSH tunnel otherwise:\n\n' +
            '  ssh -N -L 8086:127.0.0.1:8086 <mint-host>\n' +
            '  MINT_RPC_HOST=localhost\n',
    )
    process.exit(1)
}

const line = (label: string, value: string) =>
    console.log(`  ${label.padEnd(34)} ${value.padStart(18)}`)

let failed = false

try {
    const started = Date.now()
    const w = await readWalletBalance()
    const elapsed = Date.now() - started

    console.log(
        `\nMint wallet RPC OK in ${elapsed}ms — ${config.mintRpc.host}:${config.mintRpc.port} ` +
            `(${config.mintRpc.tlsCaPath ? 'mutual TLS' : 'insecure'})\n`,
    )

    console.log('Wallet')
    line('network', w.network)
    line('synced height', String(w.syncedHeight))

    console.log('\nBalance (sat)')
    line('confirmed', formatSat(w.confirmed))
    line('trusted pending (own change)', formatSat(w.trustedPending))
    console.log('  ' + '-'.repeat(53))
    line('TRUSTED SPENDABLE → reserves', formatSat(w.trustedSpendable))
    console.log('  ' + '-'.repeat(53))
    line('untrusted pending (inbound)', formatSat(w.untrustedPending))
    line('immature (coinbase)', formatSat(w.immature))
    line('total', formatSat(w.total))

    console.log(
        '\n  Reserves use TRUSTED SPENDABLE, not total: untrusted pending is inbound value\n' +
            '  that is still reversible and that CDK has not credited to a mint quote yet, so\n' +
            '  counting it would raise assets with no matching liability.',
    )

    // The comparison is the actual point of this script.
    if (config.sources.mint) {
        const mint = await new MintSource().collect()
        const unit = mint.units.find((u) => u.unit === config.backingUnit)

        if (unit) {
            const gap = w.trustedSpendable - unit.onchainBalance

            console.log('\nChangeover impact (sat)')
            line('ledger estimate (basis today)', formatSat(unit.onchainBalance))
            line('BDK wallet (basis after)', formatSat(w.trustedSpendable))
            console.log('  ' + '-'.repeat(53))
            line('ONE-OFF STEP IN OWN CAPITAL', formatSat(gap))

            // Thresholds from reconciliationRules.ts: the long rule fires below
            // −2,000 sat/h over 48h, the short one below −20,000 sat/h over 6h.
            // Only a negative step can trip them — the rules alert on decline.
            const step = gap < 0n ? -gap / 1000n : 0n
            if (step > 96_000n) {
                console.log(
                    `\n  ⚠ A drop of ${formatSat(gap)} sat will read as roughly ` +
                        `${(Number(step) / 48).toFixed(0)} sat/h across a 48h window, which is past\n` +
                        `    the reserve_drift_long threshold of 2,000 sat/h. Expect one WARNING after\n` +
                        `    the deploy; it ages out of the window on its own within 48h.`,
                )
            } else if (gap !== 0n) {
                console.log(
                    `\n  The step is small enough that neither drift rule will trip on it\n` +
                        `  (the long rule needs a drop over ~96,000 sat to reach its threshold).`,
                )
            }
        }
        // ── Deposit classification ──────────────────────────────────────────
        const dep = await collectOnchainDeposits()

        console.log('\nDeposit classification (sat)')
        if (dep.error) {
            console.log(`  wallet transaction read FAILED: ${dep.error}`)
        }
        line('awaiting credit → unclaimed', formatSat(dep.awaitingCredit))
        line('  in that state', `${dep.awaitingCreditCount} tx`)
        line('unattributed → own capital', formatSat(dep.unattributed))
        line('  in that state', `${dep.unattributedCount} tx`)
        line('unclassified & uncredited', formatSat(dep.unclassified))
        line('  in that state', `${dep.unclassifiedCount} tx`)

        if (dep.uncredited.length > 0) {
            console.log('\n  Confirmed but never booked by the mint:')
            for (const d of dep.uncredited) {
                console.log(
                    `    ${d.txid.slice(0, 16)}… ${formatSat(d.receivedMsat).padStart(9)} sat  ` +
                        `${(d.uncreditedForSec / 3600).toFixed(1)}h  ${d.classification}` +
                        (d.cospent ? '  ⚠ ALREADY CO-SPENT — clustering exposure' : ''),
                )
            }
            console.log(
                '\n    Below the mint\'s minimum receive amount these are never credited: CDK\n' +
                    '    tests each receive on its own and ignores what the quote already holds.\n' +
                    '    They are harmless while they sit. They stop being harmless when the wallet\n' +
                    '    spends them alongside its own UTXOs, which links those addresses together.',
            )
        }

        if (!config.bitcoinRpc.enabled) {
            console.log(
                '\n  ⚠ BITCOIN_RPC_URL is not set. Deposits cannot be attributed to a mint quote,\n' +
                    '    so each counts as unclaimed until the mint books it or 24h passes. That is\n' +
                    '    the conservative direction and cannot cause a false shortfall, but operator\n' +
                    "    liquidity sits in the mint's liabilities meanwhile — and co-spend detection\n" +
                    '    is off entirely, since it needs transaction inputs. Set BITCOIN_RPC_URL.',
            )
        } else {
            try {
                const info = await chainInfo()
                console.log(
                    `\n  bitcoind OK — chain ${info.chain}, height ${info.blocks}` +
                        (info.pruned ? ' (PRUNED)' : '') +
                        '. Deposits are attributed from their own output addresses.',
                )
            } catch (e: any) {
                failed = true
                console.error(`\n  bitcoind FAILED: ${String(e?.message ?? e)}`)
            }
        }

        await closeMintPool()
    }

    console.log('')
} catch (e: any) {
    failed = true
    console.error(`\nMint wallet RPC read FAILED: ${String(e?.message ?? e)}\n`)
    const message = String(e?.message ?? e)

    // The server names the version it wants, so this one is self-solving and
    // does not deserve the generic checklist.
    if (message.includes('Protocol version mismatch')) {
        console.error(
            `The server stated its version in that message. Set it and re-run:\n\n` +
                `  MINT_RPC_PROTOCOL_VERSION=<server version>\n\n` +
                `Currently sending "${config.mintRpc.protocolVersion}". CDK compares this by exact\n` +
                `string, not semver, so a patch bump on its side is enough to break the call.\n`,
        )
    } else {
        console.error(
            'Check, in order:\n' +
                '  1. [mint_management_rpc] enabled = true in cdk-mintd.toml\n' +
                '  2. the listener binds an interface reachable from here — inside a container,\n' +
                '     address = "127.0.0.1" is reachable only from within it\n' +
                '  3. the tunnel is up and forwarding to that port\n' +
                "  4. this CDK build has WalletService — `cdk-mint-cli get-wallet-balance`\n" +
                '     against the same endpoint should print a balance\n' +
                '  5. TLS: all three of MINT_RPC_TLS_CA / _CLIENT_CERT / _CLIENT_KEY, or none\n',
        )
    }
} finally {
    closeMintRpcClient()
}

process.exit(failed ? 1 : 0)
