import type {
  Alert,
  CollectorStatus,
  DeltaResponse,
  Observation,
  TimeseriesPoint,
} from './types'

/**
 * Relative paths only. The /api/* route handler proxies to the backend (see
 * src/pages/api/[...path].ts), so the browser never needs to know the API's
 * address — which means it is not baked into this bundle at build time and can
 * be changed with a restart.
 *
 * Safe because every fetch here runs in an effect, i.e. client-side, where a
 * relative URL resolves against the page origin.
 */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${path}`)
  }
  return (await res.json()) as T
}

export function getCollectorStatus() {
  return get<CollectorStatus>('/api/collector/status')
}

export function getLatestObservation() {
  return get<{ observation: Observation | null }>('/api/observations/latest')
}

/**
 * Minutes, not hours: the shared range control reaches down to 5 minutes, which
 * hours cannot express — the endpoint parses an integer, so a fractional hour
 * became 0 and silently fell back to the 24h default.
 */
export function getTimeseries(minutes: number) {
  return get<{
    from: string
    hours: number
    minutes: number
    count: number
    points: TimeseriesPoint[]
  }>(`/api/timeseries?minutes=${minutes}`)
}

export function getDeltas(minutes: number) {
  return get<DeltaResponse>(`/api/deltas?minutes=${minutes}`)
}

export function getAlerts(status: 'FIRING' | 'RESOLVED' | 'ALL' = 'FIRING') {
  return get<{ count: number; alerts: Alert[] }>(`/api/alerts?status=${status}`)
}

export function getObservations(params: { from?: string; to?: string; limit?: number } = {}) {
  const q = new URLSearchParams()
  if (params.from) q.set('from', params.from)
  if (params.to) q.set('to', params.to)
  if (params.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return get<{ from: string; to: string; count: number; observations: Observation[] }>(
    `/api/observations${qs ? `?${qs}` : ''}`,
  )
}
