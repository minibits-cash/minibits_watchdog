import Fastify, { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify'
import cors from '@fastify/cors'
import AppError from './utils/AppError'
import { config } from './config'
import { bigintReplacer } from './utils/json'
import { observationRoutes } from './routes/observationRoutes'
import { alertRoutes } from './routes/alertRoutes'

export async function buildApp(): Promise<FastifyInstance> {
    const app: FastifyInstance = Fastify({
        trustProxy: false,
        logger:
            process.env.NODE_ENV !== 'test'
                ? { timestamp: () => `, "time":"${new Date().toISOString()}"` }
                : false,
    })

    // Every monetary value is a BigInt, which JSON.stringify throws on.
    // Serialised as strings to avoid silently losing precision on msat totals.
    app.setReplySerializer((payload) => JSON.stringify(payload, bigintReplacer))

    await app.register(cors, {
        origin: config.server.corsOrigin.split(',').map((o) => o.trim()),
        methods: ['GET', 'POST'],
    })

    app.setErrorHandler((err: FastifyError | AppError, _req: FastifyRequest, res: FastifyReply) => {
        if (err instanceof AppError) {
            const { statusCode, name, message, params } = err
            return res.code(statusCode).send({ error: { statusCode, name, message, params } })
        }
        const statusCode = err.statusCode ?? 500
        return res.code(statusCode).send({ error: { statusCode, name: err.name, message: err.message } })
    })

    app.get('/health', async () => ({ status: 'ok' }))

    await app.register(observationRoutes, { prefix: '/api' })
    await app.register(alertRoutes, { prefix: '/api' })

    return app
}
