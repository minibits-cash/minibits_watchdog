import type { Msat } from './types'

/**
 * msat strings are converted to sat with BigInt arithmetic, never by parsing to
 * a float first — the whole point of carrying msat as a string is to not lose
 * precision on the way to the screen.
 */
export function msatToSat(v: Msat | null | undefined): bigint | null {
  if (v === null || v === undefined || v === '') return null
  try {
    return BigInt(v) / 1000n
  } catch {
    return null
  }
}

export function formatSat(v: Msat | null | undefined): string {
  const sat = msatToSat(v)
  if (sat === null) return '—'
  return sat.toLocaleString('en-US')
}

/** Signed rendering, for deltas where the sign is the point. */
export function formatSatSigned(v: Msat | null | undefined): string {
  const sat = msatToSat(v)
  if (sat === null) return '—'
  const sign = sat > 0n ? '+' : ''
  return `${sign}${sat.toLocaleString('en-US')}`
}

export function formatAge(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
