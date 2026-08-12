import prisma from '../utils/prismaClient'
import { config } from '../config'
import { log } from '../services/logService'
import { runSource, SourceResult } from '../sources/types'
import { LndSource, LndReading } from '../sources/lnd/lndSource'
import { MintSource, MintReading } from '../sources/mint/mintSource'
import { writeReconciliation } from './reconciliation'
import { evaluateRules } from '../alerts/engine'
import { pingHeartbeat } from '../services/heartbeat'

/**
 * Collection tick. See SPEC.md §6.
 *
 * All sources are read concurrently under a per-source timeout, so one slow or
 * dead source cannot delay or abort the tick. The Observation row is always
 * written — including when every source failed — because a gap in the series
 * must be distinguishable from "nothing happened", and "the mint DB is down"
 * is itself a thing we need recorded.
 */

const lndSource = new LndSource()
const mintSource = new MintSource()

/** A source that is switched off or not yet implemented — recorded, not treated as a failure. */
async function skipped<T>(): Promise<SourceResult<T>> {
    return { status: 'SKIPPED', readAt: new Date(), durationMs: 0 }
}

let running = false

export async function runTick(): Promise<number> {
    if (running) {
        log.warn('[collector] previous tick still running, skipping this one')
        return -1
    }
    running = true

    const tickStartedAt = Date.now()
    const observedAt = new Date(tickStartedAt)

    try {
        // Sources run concurrently so observedAt stays coherent across them.
        const [lnd, mint] = await Promise.all([
            config.sources.lnd
                ? runSource(lndSource, config.collect.sourceTimeoutMs)
                : skipped<LndReading>(),
            config.sources.mint
                ? runSource(mintSource, config.collect.sourceTimeoutMs)
                : skipped<MintReading>(),
        ])

        const readAts = [lnd, mint].filter((r) => r.status === 'OK').map((r) => r.readAt.getTime())
        const skewMs =
            readAts.length > 1 ? Math.max(...readAts) - Math.min(...readAts) : 0

        const observation = await prisma.observation.create({
            data: {
                observedAt,
                skewMs,
                durationMs: Date.now() - tickStartedAt,
                lndStatus: lnd.status,
                mintStatus: mint.status,
                lndError: lnd.error ?? null,
                mintError: mint.error ?? null,
                lnd: lnd.status === 'OK' && lnd.data ? { create: toLndSnapshot(lnd.data) } : undefined,
                mints:
                    mint.status === 'OK' && mint.data
                        ? { create: mint.data.units.map(toMintSnapshot) }
                        : undefined,
            },
        })

        // Reconciliation needs both sides of the identity from the same tick.
        // With either source missing it is skipped rather than computed from a
        // stale half, which would fabricate a delta out of nothing.
        if (lnd.status === 'OK' && lnd.data && mint.status === 'OK' && mint.data) {
            await writeReconciliation(observation.id, lnd.data, mint.data)
        }

        // Rules evaluate against the persisted observation, so they see exactly
        // what was stored rather than in-memory values — the same thing the
        // dashboard and any later re-analysis will see.
        const stored = await prisma.observation.findUnique({
            where: { id: observation.id },
            include: { lnd: true, mints: true, reconciliation: true },
        })

        if (stored) {
            try {
                await evaluateRules(stored as any)
            } catch (e: any) {
                // Rule evaluation must never lose an observation that was
                // already collected and persisted.
                log.error('[collector] rule evaluation failed', { message: String(e?.message ?? e) })
            }
        }

        // SKIPPED is a configuration choice, not a failure — warning on it would
        // train us to ignore the warnings that matter.
        const failed = [lnd, mint].filter((r) => r.status !== 'OK' && r.status !== 'SKIPPED')

        if (failed.length === 0) {
            log.info('[collector] tick complete', {
                observationId: observation.id,
                lnd: lnd.status,
                mint: mint.status,
                skewMs,
                durationMs: Date.now() - tickStartedAt,
            })
        } else {
            log.warn('[collector] tick complete with source failure', {
                observationId: observation.id,
                lnd: lnd.status,
                lndError: lnd.error,
                mint: mint.status,
                mintError: mint.error,
            })
        }

        // The heartbeat asserts "the watchdog is alive and completing ticks",
        // not "everything is healthy". A failed source is reported by its own
        // rule; conflating the two would make the deadman's switch fire for
        // conditions it cannot distinguish.
        await pingHeartbeat(true, undefined, {
            observationId: observation.id,
            lnd: lnd.status,
            mint: mint.status,
            durationMs: Date.now() - tickStartedAt,
        })

        return observation.id
    } catch (e: any) {
        // A failure here means we could not even record the observation — the
        // watchdog itself is impaired, so the deadman's switch is told directly
        // rather than left to infer it from missing pings.
        const message = String(e?.message ?? e)
        log.error('[collector] tick failed to persist', { message })
        await pingHeartbeat(false, `tick failed to persist: ${message}`)
        return -1
    } finally {
        running = false
    }
}

function toLndSnapshot(r: LndReading) {
    return {
        channelLocal: r.channelLocal,
        channelRemote: r.channelRemote,
        channelUnsettledLocal: r.channelUnsettledLocal,
        channelUnsettledRemote: r.channelUnsettledRemote,
        channelPendingOpenLocal: r.channelPendingOpenLocal,
        channelPendingOpenRemote: r.channelPendingOpenRemote,

        onchainTotal: r.onchainTotal,
        onchainConfirmed: r.onchainConfirmed,
        onchainUnconfirmed: r.onchainUnconfirmed,
        onchainLocked: r.onchainLocked,
        onchainReservedAnchor: r.onchainReservedAnchor,

        limbo: r.limbo,
        pendingOpenCount: r.pendingOpenCount,
        pendingForceCloseCount: r.pendingForceCloseCount,
        waitingCloseCount: r.waitingCloseCount,

        blockHeight: r.blockHeight,
        syncedToChain: r.syncedToChain,
        syncedToGraph: r.syncedToGraph,
        numActiveChannels: r.numActiveChannels,
        numInactiveChannels: r.numInactiveChannels,
        numPendingChannels: r.numPendingChannels,
        version: r.version,

        raw: JSON.parse(JSON.stringify(r.raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    }
}

function toMintSnapshot(u: MintReading['units'][number]) {
    return {
        unit: u.unit,
        issued: u.issued,
        redeemed: u.redeemed,
        feeCollected: u.feeCollected,
        proofsPending: u.proofsPending,
        proofsPendingCount: u.proofsPendingCount,
        unclaimedMintQuotes: u.unclaimedMintQuotes,
        unclaimedMintQuotesCount: null, // ledger tables carry amounts, not quote counts
        overIssuedMintQuotes: u.overIssuedMintQuotes,
        pendingMeltQuotes: u.pendingMeltQuotes,
        pendingMeltQuotesCount: u.pendingMeltQuotesCount,
        meltFeeReserve: u.meltFeeReserve,
        sagasInFlight: u.sagasInFlight,
        meltRequestsInFlight: u.meltRequestsInFlight,
        meltRequestsInputsAmount: u.meltRequestsInputsAmount,
        onchainBalance: u.onchainBalance,
        onchainDeposits: u.onchainDeposits,
        onchainWithdrawn: u.onchainWithdrawn,
        onchainQuotes: u.onchainQuotes,
        keysetsActive: u.keysetsActive,
        keysetsTotal: u.keysetsTotal,
        keysetBreakdown: JSON.parse(
            JSON.stringify(u.keysetBreakdown, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        ),
        raw: JSON.parse(JSON.stringify(u.raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    }
}

let timer: NodeJS.Timeout | undefined

export function startCollector(): void {
    if (timer) {
        log.warn('[collector] already started')
        return
    }

    // Run once immediately so a restart does not leave a hole the length of the
    // interval, then settle into the schedule.
    void runTick()

    timer = setInterval(() => {
        void runTick()
    }, config.collect.intervalMs)

    log.info('[collector] started', { intervalMs: config.collect.intervalMs })
}

export function stopCollector(): void {
    if (timer) {
        clearInterval(timer)
        timer = undefined
        log.info('[collector] stopped')
    }
}
