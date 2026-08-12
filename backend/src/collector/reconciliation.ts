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
 *   Own capital     = Reserves − Ecash issued + Proofs pending
 *   Remaining delta = Δ Own capital − Δ Unclaimed − Δ Cold storage − Δ Mint fees
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
    const mintBalance = mintUnit.issued - mintUnit.redeemed
    const proofsPending = mintUnit.proofsPending
    const unclaimed = mintUnit.unclaimedMintQuotes
    const mintFeesCollected = mintUnit.feeCollected

    // The mint's own on-chain wallet is a second asset pool it controls
    // directly, so it belongs in reserves alongside the node's balances.
    const mintOnchain = mintUnit.onchainBalance

    const ownCapital = totalNode + coldStorage + mintOnchain - mintBalance + proofsPending

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
    let deltaColdStorage: bigint | null = null
    let deltaMintFees: bigint | null = null
    let remainingDelta: bigint | null = null
    let elapsedMs: number | null = null

    if (prev && observation) {
        elapsedMs = observation.observedAt.getTime() - prev.observation.observedAt.getTime()
        deltaOwnCapital = ownCapital - prev.ownCapital
        deltaUnclaimed = unclaimed - prev.unclaimed
        deltaColdStorage = coldStorage - prev.coldStorage
        deltaMintFees = mintFeesCollected - prev.mintFeesCollected

        // Remaining delta measures UNEXPLAINED change. Every subtracted term is
        // explained: unclaimed quotes by mint state, cold storage by operator
        // declaration, mint fees by the mint's own ledger.
        //
        // Subtracting fee income is not bookkeeping neatness — earning +X while
        // something drains −X would otherwise leave this at zero and the mint
        // looking healthy. Removing known income exposes the drain.
        remainingDelta = deltaOwnCapital - deltaUnclaimed - deltaColdStorage - deltaMintFees

        if (deltaColdStorage !== 0n) {
            log.warn('[reconciliation] declared cold-storage reserves changed', {
                fromSat: (prev.coldStorage / 1000n).toString(),
                toSat: (coldStorage / 1000n).toString(),
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
            mintBalance,
            proofsPending,
            ownCapital,
            unclaimed,
            mintFeesCollected,
            prevObservationId: prev?.observationId ?? null,
            elapsedMs,
            deltaOwnCapital,
            deltaUnclaimed,
            deltaColdStorage,
            deltaMintFees,
            remainingDelta,
        },
    })

    log.info('[reconciliation] written', {
        observationId,
        unit,
        totalNodeSat: (totalNode / 1000n).toString(),
        mintBalanceSat: (mintBalance / 1000n).toString(),
        ownCapitalSat: (ownCapital / 1000n).toString(),
        remainingDeltaSat: remainingDelta === null ? null : (remainingDelta / 1000n).toString(),
    })
}
