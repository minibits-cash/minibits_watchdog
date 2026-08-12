/**
 * Read LND once through the real collector code path and print the result.
 *
 * Uses LndSource rather than a hand-rolled gRPC call, so this verifies the code
 * that will actually run — including the strict field extraction, which is the
 * part most likely to break across LND versions.
 *
 *   npm run probe:lnd
 */
import 'dotenv/config'
import { LndSource, totalNodeBalance } from '../src/sources/lnd/lndSource'
import { formatSat } from '../src/utils/money'

const source = new LndSource()

try {
    const started = Date.now()
    const r = await source.collect()
    const elapsed = Date.now() - started

    const line = (label: string, value: string) =>
        console.log(`  ${label.padEnd(34)} ${value.padStart(18)}`)

    console.log(`\nLND read OK in ${elapsed}ms\n`)

    console.log('Node health')
    line('version', r.version)
    line('block height', String(r.blockHeight))
    line('synced to chain', String(r.syncedToChain))
    line('synced to graph', String(r.syncedToGraph))
    line('channels active / inactive', `${r.numActiveChannels} / ${r.numInactiveChannels}`)
    line('pending force-closes', String(r.pendingForceCloseCount))

    console.log('\nBalances (sat)')
    line('channel local', formatSat(r.channelLocal))
    line('channel unsettled local', formatSat(r.channelUnsettledLocal))
    line('channel pending open local', formatSat(r.channelPendingOpenLocal))
    line('on-chain confirmed', formatSat(r.onchainConfirmed))
    line('on-chain unconfirmed', formatSat(r.onchainUnconfirmed))
    line('on-chain reserved (anchor)', formatSat(r.onchainReservedAnchor))
    line('limbo', formatSat(r.limbo))
    console.log('  ' + '-'.repeat(53))
    line('TOTAL NODE BALANCE', formatSat(totalNodeBalance(r)))

    console.log(
        '\n  (Total node balance = channel local + on-chain total + limbo,' +
            '\n   matching the tracking sheet. Unsettled HTLCs are excluded —' +
            '\n   they are already out of channel local while in flight.)\n',
    )
} catch (e: any) {
    console.error(`\nLND read FAILED: ${e?.message ?? e}\n`)
    process.exitCode = 1
}
