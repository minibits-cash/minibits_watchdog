import { FastifyInstance, FastifyRequest } from 'fastify'
import prisma from '../utils/prismaClient'
import { allRules } from '../rules'
import { loadConfigs } from '../alerts/engine'
import { getNotifier, Notifier } from '../alerts/notifier'
import { MultiNotifier } from '../alerts/multiNotifier'
import { pingHeartbeat } from '../services/heartbeat'
import { config } from '../config'

export async function alertRoutes(app: FastifyInstance) {
    /**
     * Verify the notification path end to end.
     *
     * An alerting system whose transport has never been exercised is an
     * assumption, not a safeguard — and the moment you find out it was broken is
     * exactly the moment you needed it.
     */
    app.post('/notify/test', async (_req, res) => {
        const notifier = getNotifier()

        if (notifier.name === 'log') {
            return res.code(409).send({
                error: {
                    statusCode: 409,
                    message:
                        'No external notifier configured — set ENABLED_NOTIFIERS (ntfy, email). Alerts are currently only written to the log.',
                },
            })
        }

        const message = {
            ruleId: 'notify_test',
            dedupeKey: 'manual',
            severity: 'INFO' as const,
            title: 'Minibits Watchdog test notification',
            detail: 'Delivery path is working. Triggered manually via /api/notify/test.',
            resolved: false,
        }

        // Exercise each transport individually rather than through the fan-out:
        // MultiNotifier succeeds when any one transport works, which is right for
        // real alerts but would hide a broken channel during a deliberate test.
        const targets: Notifier[] =
            notifier instanceof MultiNotifier ? notifier.targets : [notifier]

        const results = await Promise.all(
            targets.map(async (t) => {
                try {
                    await t.send(message)
                    return { transport: t.name, redacted: t.redacted === true, delivered: true as const }
                } catch (e: any) {
                    return {
                        transport: t.name,
                        redacted: t.redacted === true,
                        delivered: false as const,
                        error: String(e?.message ?? e),
                    }
                }
            }),
        )

        const failed = results.filter((r) => !r.delivered)

        if (failed.length > 0) {
            await pingHeartbeat(
                false,
                `test notification failed on: ${failed.map((f) => f.transport).join(', ')}`,
            )
        }

        return res.code(failed.length === results.length ? 502 : 200).send({
            delivered: failed.length < results.length,
            results,
        })
    })

    /** Heartbeat configuration and a manual ping, for verifying the deadman's switch. */
    app.post('/heartbeat/test', async (_req, res) => {
        if (!config.heartbeatUrl) {
            return res.code(409).send({
                error: { statusCode: 409, message: 'HEARTBEAT_URL is not configured.' },
            })
        }
        await pingHeartbeat(true, 'manual test ping')
        return { pinged: true }
    })

    /** Currently firing alerts, most severe first. */
    app.get('/alerts', async (req: FastifyRequest<{ Querystring: { status?: string } }>) => {
        const status = req.query.status?.toUpperCase()
        const where = status === 'ALL' ? {} : { status: (status ?? 'FIRING') as any }

        const alerts = await prisma.alertState.findMany({
            where,
            orderBy: [{ severity: 'desc' }, { firedAt: 'desc' }],
            include: { events: { orderBy: { at: 'desc' }, take: 5 } },
        })

        return { count: alerts.length, alerts }
    })

    /** Transition and delivery history. */
    app.get('/alerts/events', async (req: FastifyRequest<{ Querystring: { limit?: string } }>) => {
        const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, 1000)
        const events = await prisma.alertEvent.findMany({
            orderBy: { at: 'desc' },
            take: limit,
            include: { alertState: { select: { ruleId: true, dedupeKey: true, title: true } } },
        })
        return { count: events.length, events }
    })

    /** Registered rules with their current tuning. */
    app.get('/rules', async () => {
        const configs = await loadConfigs()
        return {
            rules: allRules.map((r) => {
                const c = configs.get(r.id)
                return {
                    id: r.id,
                    description: r.description,
                    enabled: c?.enabled ?? true,
                    severity: c?.severity,
                    forEvaluations: c?.forEvaluations,
                    clearEvaluations: c?.clearEvaluations,
                    cooldownSeconds: c?.cooldownSeconds,
                    notifyOnResolve: c?.notifyOnResolve,
                    params: c?.params,
                }
            }),
        }
    })

    /** Tune a rule without a redeploy. */
    app.patch(
        '/rules/:ruleId',
        async (
            req: FastifyRequest<{
                Params: { ruleId: string }
                Body: Partial<{
                    enabled: boolean
                    severity: string
                    forEvaluations: number
                    clearEvaluations: number
                    cooldownSeconds: number
                    notifyOnResolve: boolean
                    params: Record<string, unknown>
                }>
            }>,
            res,
        ) => {
            const { ruleId } = req.params

            if (!allRules.some((r) => r.id === ruleId)) {
                return res.code(404).send({ error: { statusCode: 404, message: `Unknown rule: ${ruleId}` } })
            }

            await loadConfigs() // ensure the row exists before updating

            const updated = await prisma.ruleConfig.update({
                where: { ruleId },
                data: {
                    enabled: req.body.enabled,
                    severity: req.body.severity as any,
                    forEvaluations: req.body.forEvaluations,
                    clearEvaluations: req.body.clearEvaluations,
                    cooldownSeconds: req.body.cooldownSeconds,
                    notifyOnResolve: req.body.notifyOnResolve,
                    // Replaced wholesale, not merged — safe because the engine
                    // overlays stored params on the rule's code defaults, so a
                    // partial object overrides only the keys it names.
                    params: req.body.params as any,
                },
            })

            return { rule: updated }
        },
    )
}
