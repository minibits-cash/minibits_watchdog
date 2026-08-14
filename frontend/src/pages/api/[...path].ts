import type { NextApiRequest, NextApiResponse } from 'next'

/**
 * Proxies /api/* to the watchdog backend, resolving the target PER REQUEST.
 *
 * ── Why a route handler and not `rewrites()` ─────────────────────────────────
 *
 * `rewrites()` in next.config.mjs is evaluated at BUILD time and baked into
 * routes-manifest.json, so `next start` ignores any later change to the env var
 * it read. That is the same build-time trap as NEXT_PUBLIC_API_URL, just moved:
 * verified by pointing one build at two different backends and watching both
 * reach the same one.
 *
 * A route handler runs on every request, so `process.env.BACKEND_URL` is read
 * when the request arrives — configuration by restart, as intended.
 *
 * ── What this buys ──────────────────────────────────────────────────────────
 *
 *  - One port to tunnel: the browser only ever talks to the Next server.
 *  - No CORS in the browser path — dashboard and API share an origin.
 *  - No API address in the client bundle, so no rebuild to retarget it.
 */
const backendUrl = () => (process.env.BACKEND_URL ?? 'http://127.0.0.1:3005').replace(/\/+$/, '')

/** Bounded so a hung backend cannot pin a dashboard request open indefinitely. */
const TIMEOUT_MS = 30_000

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    const segments = Array.isArray(req.query.path) ? req.query.path : [req.query.path ?? '']

    // Preserve the query string, minus the catch-all's own `path` parameter.
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(req.query)) {
        if (k === 'path' || v === undefined) continue
        for (const one of Array.isArray(v) ? v : [v]) params.append(k, one)
    }
    const qs = params.toString()
    const target = `${backendUrl()}/api/${segments.join('/')}${qs ? `?${qs}` : ''}`

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined

    try {
        const upstream = await fetch(target, {
            method: req.method,
            headers: hasBody ? { 'content-type': 'application/json' } : undefined,
            body: hasBody ? JSON.stringify(req.body) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })

        const text = await upstream.text()
        res.status(upstream.status)
        res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
        res.send(text)
    } catch (e: any) {
        // Surface the target so a misconfigured BACKEND_URL is diagnosable from
        // the dashboard rather than only from the server log.
        res.status(502).json({
            error: {
                statusCode: 502,
                message: `Watchdog API unreachable at ${backendUrl()}: ${String(e?.message ?? e)}`,
            },
        })
    }
}
