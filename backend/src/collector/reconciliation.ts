import prisma from '../utils/prismaClient'
import { config } from '../config'
import { log } from '../services/logService'
import { LndReading, totalNodeBalance } from '../sources/lnd/lndSource'
import { MintReading } from '../sources/mint/mintSource'

/**
 * Reconciliation for the backing unit. See SPEC.md §3.
 *
 *   Reserves        = Channel local + On-chain (LND) + Limbo + Cold storage
 *                     + Mint on-chain (BDK)
 *   Own capital     = Reserves − Ecash issued + Unspendable ecash + Proofs pending
 *   Remaining delta = Δ Own capital − Δ Unclaimed − Δ Deposits awaiting credit
 *                     − Δ Dust received − Δ Cold storage − Δ Unspendable ecash
 *                     − Δ Mint fees
 *
 * `Own capital` is the mint's equity: reserves in excess of what it owes. It is
 * a level and carries no signal on its own, being accumulated
 * over-capitalisation from routing fee income, the mint rounding Lightning fees
 * up to whole sats, channel reserve and initial capitalisation. Only
 * `Remaining delta` — the part of its change that nothing explains — is
 * alertable.
 *
 * (Called "Total difference" in the original tracking spreadsheet.)
 *
 * Deltas are stored against the immediately preceding reconciliation, mirroring
 * the manual sheet. Windowed rates are computed at query time so changing the
 * window definitions never requires rewriting history.
 */
export async function writeReconciliation(
    observationId: number,
    lnd: LndReading,
    mint: MintReading,
): Promise<void> {
    const unit = config.backingUnit
    const mintUnit = mint.units.find((u) => u.unit === unit)

    if (!mintUnit) {
        log.warn('[reconciliation] no mint data for backing unit, skipping', {
            unit,
            available: mint.units.map((u) => u.unit),
        })
        return
    }

    const totalNode = totalNodeBalance(lnd)
    const coldStorage = BigInt(config.coldStorageReservesSat) * 1000n
    // Not netted off mintBalance: that stays the mint's own figure, so it can be
    // checked against the database. See config.provablyUnspendableEcashSat.
    const provablyUnspendable = BigInt(config.provablyUnspendableEcashSat) * 1000n
    const mintBalance = mintUnit.issued - mintUnit.redeemed
    const proofsPending = mintUnit.proofsPending
    const unclaimed = mintUnit.unclaimedMintQuotes
    const mintFeesCollected = mintUnit.feeCollected

    // Confirmed in the wallet, owed ecash, not yet in CDK's books. Same
    // liability as `unclaimed`, one step earlier in its life — without it the
    // asset is recognised before the debt and the gap reads as drift.
    const depositsAwaitingCredit = mintUnit.depositsAwaitingCredit ?? 0n

    // Below the mint's minimum receive amount, so never creditable. Own capital
    // on sight, and subtracted here as explained so its arrival does not read as
    // an unexplained gain.
    const dustReceived = mintUnit.depositsDust ?? 0n

    // Operator liquidity: confirmed, matches no quote, so the mint owes nobody
    // for it. Own capital, like dust — but recorded here ONLY for the divergence
    // rule, and deliberately absent from remainingDelta. See the schema comment:
    // subtracting it would read an LND→BDK rebalance as a shortfall, because
    // both wallets sit inside reserves and the identity cannot tell an internal
    // move from an external injection.
    const depositsUnattributed = mintUnit.depositsUnattributed ?? 0n

    // The mint's own on-chain wallet is a second asset pool it controls
    // directly, so it belongs in reserves alongside the node's balances.
    //
    // Two possible bases, and they are NOT interchangeable:
    //
    //   WALLET — BDK's own balance over CDK's gRPC. A measurement. Can express a
    //            movement CDK never booked, which is the point of having it.
    //   LEDGER — inferred from paid quotes less booked payouts. Self-consistent
    //            by construction, and therefore blind to exactly that.
    //
    // `trustedSpendable` (confirmed + own unconfirmed change), not `total`:
    // untrusted pending is inbound value that is still reversible AND that CDK
    // has not credited to a mint quote yet, so counting it would raise assets
    // with no matching liability and read as unexplained drift until it
    // confirmed. Symmetrical with excluding in-flight HTLCs on the LND side.
    //
    // When the RPC is configured but did not answer this tick, no row is written
    // at all — see below. Falling back to LEDGER would step own capital by the
    // divergence between the bases and then step back, manufacturing drift in
    // both directions every time the endpoint flapped.
    const usingWallet = config.mintRpc.enabled
    const mintOnchain = usingWallet ? mintUnit.walletTrustedSpendable : mintUnit.onchainBalance

    if (mintOnchain === null) {
        log.warn('[reconciliation] BDK wallet balance unavailable, skipping', {
            unit,
            note:
                'the mint RPC is configured, so the ledger estimate is deliberately NOT ' +
                'substituted — a basis change would read as drift. This tick is a gap.',
        })
        return
    }

    const ownCapital =
        totalNode + coldStorage + mintOnchain - mintBalance + provablyUnspendable + proofsPending

    // Previous reconciliation for the same unit, for the delta terms.
    const prev = await prisma.reconciliation.findFirst({
        where: { unit },
        orderBy: { id: 'desc' },
        include: { observation: { select: { observedAt: true } } },
    })

    const observation = await prisma.observation.findUnique({
        where: { id: observationId },
        select: { observedAt: true },
    })

    let deltaOwnCapital: bigint | null = null
    let deltaUnclaimed: bigint | null = null
    let deltaDepositsAwaitingCredit: bigint | null = null
    let deltaDustReceived: bigint | null = null
    let deltaColdStorage: bigint | null = null
    let deltaProvablyUnspendable: bigint | null = null
    let deltaMintFees: bigint | null = null
    let remainingDelta: bigint | null = null
    let elapsedMs: number | null = null

    if (prev && observation) {
        elapsedMs = observation.observedAt.getTime() - prev.observation.observedAt.getTime()
        deltaOwnCapital = ownCapital - prev.ownCapital
        deltaUnclaimed = unclaimed - prev.unclaimed
        deltaDepositsAwaitingCredit = depositsAwaitingCredit - prev.depositsAwaitingCredit
        deltaDustReceived = dustReceived - prev.dustReceived
        deltaColdStorage = coldStorage - prev.coldStorage
        deltaProvablyUnspendable = provablyUnspendable - prev.provablyUnspendable
        deltaMintFees = mintFeesCollected - prev.mintFeesCollected

        // Remaining delta measures UNEXPLAINED change. Every subtracted term is
        // explained: unclaimed quotes by mint state, cold storage and unspendable
        // ecash by operator declaration, mint fees by the mint's own ledger.
        //
        // Subtracting fee income is not bookkeeping neatness — earning +X while
        // something drains −X would otherwise leave this at zero and the mint
        // looking healthy. Removing known income exposes the drain.
        remainingDelta =
            deltaOwnCapital -
            deltaUnclaimed -
            deltaDepositsAwaitingCredit -
            deltaDustReceived -
            deltaColdStorage -
            deltaProvablyUnspendable -
            deltaMintFees

        if (deltaColdStorage !== 0n) {
            log.warn('[reconciliation] declared cold-storage reserves changed', {
                fromSat: (prev.coldStorage / 1000n).toString(),
                toSat: (coldStorage / 1000n).toString(),
                note: 'excluded from remainingDelta as a declared movement',
            })
        }

        if (deltaProvablyUnspendable !== 0n) {
            log.warn('[reconciliation] declared unspendable ecash changed', {
                fromSat: (prev.provablyUnspendable / 1000n).toString(),
                toSat: (provablyUnspendable / 1000n).toString(),
                note: 'excluded from remainingDelta as a declared movement',
            })
        }
    }

    await prisma.reconciliation.create({
        data: {
            observationId,
            unit,
            totalNodeBalance: totalNode,
            coldStorage,
            mintOnchain,
            mintOnchainBasis: usingWallet ? 'WALLET' : 'LEDGER',
            mintOnchainLedger: mintUnit.onchainBalance,
            mintBalance,
            provablyUnspendable,
            proofsPending,
            ownCapital,
            unclaimed,
            depositsAwaitingCredit,
            dustReceived,
            depositsUnattributed,
            mintFeesCollected,
            prevObservationId: prev?.observationId ?? null,
            elapsedMs,
            deltaOwnCapital,
            deltaUnclaimed,
            deltaDepositsAwaitingCredit,
            deltaDustReceived,
            deltaColdStorage,
            deltaProvablyUnspendable,
            deltaMintFees,
            remainingDelta,
        },
    })

    log.info('[reconciliation] written', {
        observationId,
        unit,
        totalNodeSat: (totalNode / 1000n).toString(),
        mintOnchainSat: (mintOnchain / 1000n).toString(),
        mintOnchainBasis: usingWallet ? 'WALLET' : 'LEDGER',
        // Surfaced every tick rather than only when the rule fires: this is the
        // number that says whether CDK's books still describe the real wallet.
        mintOnchainLedgerGapSat: ((mintOnchain - mintUnit.onchainBalance) / 1000n).toString(),
        mintBalanceSat: (mintBalance / 1000n).toString(),
        ownCapitalSat: (ownCapital / 1000n).toString(),
        remainingDeltaSat: remainingDelta === null ? null : (remainingDelta / 1000n).toString(),
    })
}
