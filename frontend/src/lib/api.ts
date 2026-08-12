import type {
  Alert,
  CollectorStatus,
  DeltaResponse,
  Observation,
  TimeseriesPoint,
} from './types'

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3005'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
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

export function getTimeseries(hours: number) {
  return get<{ from: string; hours: number; count: number; points: TimeseriesPoint[] }>(
    `/api/timeseries?hours=${hours}`,
  )
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
