/**
 * Collector source contract.
 *
 * The collector reads every source concurrently under a per-source timeout and
 * writes one Observation. A source that fails does not abort the tick — it
 * records its status and the tick proceeds, because "the mint DB is down" is
 * itself the signal we most need to capture (SPEC.md §5).
 *
 * The interface takes N sources so minibits_server can be added later as a
 * third implementation without restructuring the collector (SPEC.md §1).
 */

export type SourceStatus = 'OK' | 'UNREACHABLE' | 'ERROR' | 'TIMEOUT' | 'SKIPPED'

export interface SourceResult<T> {
    status: SourceStatus
    /** Present only when status is OK. */
    data?: T
    error?: string
    /** When the underlying read actually completed, for skew accounting. */
    readAt: Date
    durationMs: number
}

export interface Source<T> {
    readonly name: string
    collect(): Promise<T>
}

/**
 * Run a source under a timeout, converting any failure into a status rather
 * than a thrown error.
 */
export async function runSource<T>(source: Source<T>, timeoutMs: number): Promise<SourceResult<T>> {
    const startedAt = Date.now()

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SourceTimeoutError(source.name, timeoutMs)), timeoutMs)
    })

    try {
        const data = await Promise.race([source.collect(), timeout])
        return {
            status: 'OK',
            data,
            readAt: new Date(),
            durationMs: Date.now() - startedAt,
        }
    } catch (e: any) {
        return {
            status: classify(e),
            error: e?.message ? String(e.message) : String(e),
            readAt: new Date(),
            durationMs: Date.now() - startedAt,
        }
    } finally {
        if (timer) clearTimeout(timer)
    }
}

export class SourceTimeoutError extends Error {
    constructor(sourceName: string, timeoutMs: number) {
        super(`Source "${sourceName}" timed out after ${timeoutMs}ms`)
        this.name = 'SourceTimeoutError'
    }
}

function classify(e: any): SourceStatus {
    if (e instanceof SourceTimeoutError) return 'TIMEOUT'

    const code = e?.code ? String(e.code) : ''
    const message = e?.message ? String(e.message).toUpperCase() : ''

    if (
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'EHOSTUNREACH' ||
        code === 'ETIMEDOUT' ||
        code === '14' || // grpc UNAVAILABLE
        message.includes('UNAVAILABLE') ||
        message.includes('ECONNREFUSED')
    ) {
        return 'UNREACHABLE'
    }

    return 'ERROR'
}
