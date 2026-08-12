import { useCallback, useEffect, useState } from 'react'
import { getDeltas } from '@/lib/api'
import { formatSatSigned } from '@/lib/format'
import { RangeFilter, RangeOption } from '@/components/RangeFilter'
import type { DeltaResponse } from '@/lib/types'

/**
 * Change in the reconciliation terms over a selected window.
 *
 * Its own card with its own range control, because the question it answers —
 * "what moved, and was any of it unexplained?" — is asked over a different
 * horizon than the one you want the charts drawn at.
 *
 * Deltas come from the API rather than being differenced client-side, so this
 * and the drift rules compute from the same endpoints. A dashboard that
 * disagreed with its own alerts would be worse than no dashboard.
 */
const RANGES: RangeOption[] = [
  { label: '5 min', value: 5 },
  { label: '1h', value: 60 },
  { label: '6h', value: 360 },
  { label: '24h', value: 1440 },
  { label: '7d', value: 10080 },
  { label: '30d', value: 43200 },
]

const POLL_MS = 30_000

export function ChangeCard({ unit }: { unit: string }) {
  const [minutes, setMinutes] = useState(60)
  const [data, setData] = useState<DeltaResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)

  const refresh = useCallback(async (m: number) => {
    setStale(true)
    try {
      setData(await getDeltas(m))
      setError(null)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setStale(false)
    }
  }, [])

  useEffect(() => {
    void refresh(minutes)
    const t = setInterval(() => void refresh(minutes), POLL_MS)
    return () => clearInterval(t)
  }, [refresh, minutes])

  const d = data?.deltas ?? null

  // The endpoints are real readings, but that does not make the interval
  // continuously observed.
  const gapHours =
    data?.maxGapMs && data.maxGapMs > 15 * 60_000 ? (data.maxGapMs / 3_600_000).toFixed(1) : null

  return (
    <section
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--viz-border)', background: 'var(--viz-surface)' }}
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--viz-ink)' }}>
          Change over interval ({unit})
        </h2>
        <span className="text-xs" style={{ color: 'var(--viz-muted)' }}>
          {data?.samples ? `${data.samples} observations` : ''}
          {data?.elapsedMs != null && data.elapsedMs > 0
            ? ` · spanning ${(data.elapsedMs / 3_600_000).toFixed(1)}h`
            : ''}
        </span>
      </header>

      <div className="mb-3">
        <RangeFilter label="Interval" options={RANGES} value={minutes} onChange={setMinutes} />
      </div>

      {error && (
        <p className="text-sm" style={{ color: 'var(--status-critical)' }}>
          <span aria-hidden>● </span>
          {error}
        </p>
      )}

      {!error && !d && (
        <p className="text-sm" style={{ color: 'var(--viz-ink-2)' }}>
          Not enough observations in this interval yet — two are needed to measure a change.
        </p>
      )}

      {d && (
        <div style={{ opacity: stale ? 0.55 : 1, transition: 'opacity 150ms' }}>
          <dl className="text-sm">
            <Row label="Δ Own capital" value={d.ownCapital} />
            <Row label="Δ Unclaimed" value={d.unclaimed} sign="−" note="explained by mint state" />
            <Row
              label="Δ Cold storage"
              value={d.coldStorage}
              sign="−"
              note="operator-declared"
            />
            <Row
              label="Δ Mint fees collected"
              value={d.mintFees}
              sign="−"
              note="known income"
            />
            <div
              className="mt-1 flex items-baseline justify-between gap-3 pt-2"
              style={{ borderTop: '1px solid var(--viz-axis)' }}
            >
              <dt className="pl-7 font-medium" style={{ color: 'var(--viz-ink)' }}>
                Remaining delta
              </dt>
              <dd
                className="font-mono font-semibold tabular-nums"
                style={{ color: severityColour(d.remaining) }}
              >
                {formatSatSigned(d.remaining)}
              </dd>
            </div>
          </dl>

          <p className="mt-2 text-xs" style={{ color: 'var(--viz-muted)' }}>
            Every subtracted term is an explained change, so what remains is the part nothing
            accounts for. Remaining delta is node routing income, rounding of routing fees by the mint or other that might need attention.
          </p>

          {gapHours && (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--status-warning)' }}>
              <span aria-hidden>▲ </span>
              Interval contains a {gapHours}h collection gap — the endpoints are real readings,
              but the period between them was not observed.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function Row({
  label,
  value,
  sign = '',
  note,
}: {
  label: string
  value: string
  sign?: string
  note?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="flex items-baseline gap-2">
        <span className="w-3 shrink-0 text-right font-mono" style={{ color: 'var(--viz-muted)' }}>
          {sign}
        </span>
        <span className="pl-3.5" style={{ color: 'var(--viz-ink-2)' }}>
          {label}
        </span>
        {note && (
          <span className="text-xs" style={{ color: 'var(--viz-muted)' }}>
            {note}
          </span>
        )}
      </dt>
      <dd className="font-mono tabular-nums" style={{ color: 'var(--viz-ink)' }}>
        {formatSatSigned(value)}
      </dd>
    </div>
  )
}

/** Status colour only where the value means good/bad; the sign carries it too. */
export function severityColour(msat: string): string {
  const v = BigInt(msat)
  if (v < 0n) return 'var(--status-critical)'
  if (v > 0n) return 'var(--status-good-text)'
  return 'var(--viz-ink)'
}
