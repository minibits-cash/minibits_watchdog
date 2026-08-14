import { FastifyInstance, FastifyRequest } from 'fastify'
import prisma from '../utils/prismaClient'
import { runTick } from '../collector/collector'
import { config } from '../config'

interface RangeQuery {
    from?: string
    to?: string
    limit?: string
}

export async function observationRoutes(app: FastifyInstance) {
    /** Most recent observation, with whatever snapshots it managed to capture. */
    app.get('/observations/latest', async () => {
        const observation = await prisma.observation.findFirst({
            orderBy: { observedAt: 'desc' },
            include: { lnd: true, mints: true, reconciliation: true },
        })

        return { observation }
    })

    /** Time range for charting. Defaults to the last 24h. */
    app.get('/observations', async (req: FastifyRequest<{ Querystring: RangeQuery }>) => {
        const now = Date.now()
        const from = req.query.from ? new Date(req.query.from) : new Date(now - 24 * 60 * 60 * 1000)
        const to = req.query.to ? new Date(req.query.to) : new Date(now)
        const limit = Math.min(parseInt(req.query.limit ?? '2000', 10) || 2000, 10_000)

        const observations = await prisma.observation.findMany({
            where: { observedAt: { gte: from, lte: to } },
            orderBy: { observedAt: 'asc' },
            take: limit,
            include: { lnd: true, mints: true, reconciliation: true },
        })

        return { from, to, count: observations.length, observations }
    })

    /**
     * Compact series for charting.
     *
     * Separate from /observations because that returns every raw source payload
     * per row — hundreds of kB for a day of points, nearly all of it unplotted.
     */
    app.get(
        '/timeseries',
        async (req: FastifyRequest<{ Querystring: { hours?: string; minutes?: string } }>) => {
            // `minutes` is the precise form and takes precedence; `hours` is kept
            // for callers that predate the shared range control. Hours alone could
            // not express the short end of that control at all — parseInt('0.08')
            // is 0, which fell through to the 24h default and silently plotted a
            // day when five minutes was asked for.
            const minutes = req.query.minutes
                ? Math.min(parseInt(req.query.minutes, 10) || 60, 60 * 24 * 90)
                : Math.min(parseInt(req.query.hours ?? '24', 10) || 24, 24 * 90) * 60

            const hours = minutes / 60
            const from = new Date(Date.now() - minutes * 60_000)

            const rows = await prisma.reconciliation.findMany({
                where: { observation: { observedAt: { gte: from } } },
                orderBy: { id: 'asc' },
                include: { observation: { select: { observedAt: true } } },
            })

            return {
                from,
                hours,
                minutes,
                count: rows.length,
                points: rows.map((r) => ({
                    t: r.observation.observedAt,
                    unit: r.unit,
                    totalNodeBalance: r.totalNodeBalance,
                    coldStorage: r.coldStorage,
                    mintOnchain: r.mintOnchain,
                    mintBalance: r.mintBalance,
                    proofsPending: r.proofsPending,
                    ownCapital: r.ownCapital,
                    unclaimed: r.unclaimed,
                    remainingDelta: r.remainingDelta,
                })),
            }
        },
    )

    /**
     * Change in the reconciliation terms over a window.
     *
     * Computed from the window ENDPOINTS rather than by summing per-tick deltas,
     * so a gap in the series cannot accumulate error — the same approach the
     * drift rules use, and deliberately so: the dashboard and the alert should
     * never disagree about what changed.
     *
     * `maxGapMs` is returned because the endpoints being real readings does not
     * make the interval continuously observed, and a rate quoted over mostly
     * unobserved time invites the wrong conclusion.
     */
    app.get('/deltas', async (req: FastifyRequest<{ Querystring: { minutes?: string } }>) => {
        const minutes = Math.min(parseInt(req.query.minutes ?? '60', 10) || 60, 60 * 24 * 90)
        const intervalMinutes = config.collect.intervalMs / 60_000

        // A window at or below the collection interval cannot be selected by time
        // — it would catch one sample, or none. Take the last two readings
        // instead, which is exactly "since the previous observation".
        const rows =
            minutes <= intervalMinutes
                ? (
                      await prisma.reconciliation.findMany({
                          orderBy: { id: 'desc' },
                          take: 2,
                          include: { observation: { select: { observedAt: true } } },
                      })
                  ).reverse()
                : await prisma.reconciliation.findMany({
                      where: {
                          observation: { observedAt: { gte: new Date(Date.now() - minutes * 60_000) } },
                      },
                      orderBy: { id: 'asc' },
                      include: { observation: { select: { observedAt: true } } },
                  })

        if (rows.length < 2) {
            return { minutes, samples: rows.length, elapsedMs: null, maxGapMs: null, deltas: null }
        }

        const first = rows[0]
        const last = rows[rows.length - 1]

        let maxGapMs = 0
        for (let i = 1; i < rows.length; i++) {
            const gap =
                rows[i].observation.observedAt.getTime() - rows[i - 1].observation.observedAt.getTime()
            if (gap > maxGapMs) maxGapMs = gap
        }

        const deltaOwnCapital = last.ownCapital - first.ownCapital
        const deltaUnclaimed = last.unclaimed - first.unclaimed
        const deltaColdStorage = last.coldStorage - first.coldStorage
        const deltaProvablyUnspendable = last.provablyUnspendable - first.provablyUnspendable
        const deltaMintFees = last.mintFeesCollected - first.mintFeesCollected

        // The asset and liability sides of the same window. Served from here
        // rather than differenced in the browser so every "what changed over N"
        // on the page — tiles, cards, rules — resolves to one computation over
        // one pair of endpoints. Two views disagreeing by a rounding step would
        // undermine the whole point of the dashboard.
        const reservesOf = (r: typeof first) => r.totalNodeBalance + r.coldStorage + r.mintOnchain
        const deltaReserves = reservesOf(last) - reservesOf(first)
        const deltaEcashIssued = last.mintBalance - first.mintBalance
        const deltaProofsPending = last.proofsPending - first.proofsPending

        return {
            minutes,
            samples: rows.length,
            from: first.observation.observedAt,
            to: last.observation.observedAt,
            elapsedMs: last.observation.observedAt.getTime() - first.observation.observedAt.getTime(),
            maxGapMs,
            deltas: {
                unit: last.unit,
                ownCapital: deltaOwnCapital,
                unclaimed: deltaUnclaimed,
                coldStorage: deltaColdStorage,
                provablyUnspendable: deltaProvablyUnspendable,
                mintFees: deltaMintFees,
                remaining:
                    deltaOwnCapital -
                    deltaUnclaimed -
                    deltaColdStorage -
                    deltaProvablyUnspendable -
                    deltaMintFees,
                reserves: deltaReserves,
                ecashIssued: deltaEcashIssued,
                proofsPending: deltaProofsPending,
            },
        }
    })

    /**
     * Collector health: recency of the last successful read per source.
     * Distinguishes "no data because nothing happened" from "no data because
     * collection is broken".
     */
    app.get('/collector/status', async () => {
        const [latest, lastGoodLnd, total] = await Promise.all([
            prisma.observation.findFirst({ orderBy: { observedAt: 'desc' } }),
            prisma.observation.findFirst({
                where: { lndStatus: 'OK' },
                orderBy: { observedAt: 'desc' },
            }),
            prisma.observation.count(),
        ])

        return {
            observations: total,
            latestObservedAt: latest?.observedAt ?? null,
            latestLndStatus: latest?.lndStatus ?? null,
            latestMintStatus: latest?.mintStatus ?? null,
            lastSuccessfulLndAt: lastGoodLnd?.observedAt ?? null,
        }
    })

    /** Manual tick, for testing collection without waiting for the interval. */
    app.post('/collector/run', async () => {
        const observationId = await runTick()
        return { observationId }
    })
}
