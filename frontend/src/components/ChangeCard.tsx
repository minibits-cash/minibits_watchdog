import { ReactNode } from 'react'
import { formatSatSigned } from '@/lib/format'
import type { DeltaResponse } from '@/lib/types'

/**
 * Change in the reconciliation terms over the page's selected window.
 *
 * Two cards live here because they are the same object viewed from two sides —
 * one shows what the balance sheet did, the other what it means — and they share
 * a shell, a row renderer and an empty state. Splitting them would duplicate all
 * three to no benefit.
 *
 * Both are presentational: the window is owned by the page, and the numbers come
 * from /deltas rather than being differenced client-side, so these cards, the KPI
 * tiles and the drift rules all resolve to one computation over one pair of
 * endpoints. A dashboard that disagreed with its own alerts would be worse than
 * no dashboard.
 */
export interface DeltaCardProps {
  data: DeltaResponse | null
  error?: string | null
  stale?: boolean
}

function DeltaCardShell({
  title,
  data,
  error,
  stale,
  children,
}: DeltaCardProps & { title: string; children: ReactNode }) {
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
          {title}
        </h2>
        <span className="text-xs" style={{ color: 'var(--viz-muted)' }}>
          {data?.samples ? `${data.samples} observations` : ''}
          {data?.elapsedMs != null && data.elapsedMs > 0
            ? ` · spanning ${(data.elapsedMs / 3_600_000).toFixed(1)}h`
            : ''}
        </span>
      </header>

      {error && (
        <p className="text-sm" style={{ color: 'var(--status-critical)' }}>
          <span aria-hidden>● </span>
          {error}
        </p>
      )}

      {!error && !data?.deltas && (
        <p className="text-sm" style={{ color: 'var(--viz-ink-2)' }}>
          Not enough observations in this interval yet — two are needed to measure a change.
        </p>
      )}

      {data?.deltas && (
        <div style={{ opacity: stale ? 0.55 : 1, transition: 'opacity 150ms' }}>
          {children}

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

export function ChangeCard({ data, error, stale }: DeltaCardProps) {
  const d = data?.deltas

  return (
    <DeltaCardShell title="Change in own capital" data={data} error={error} stale={stale}>
      {d && (
        <>
          <dl className="text-sm">
            <Row label="Δ Own capital" value={d.ownCapital} />
            <Row label="Δ Unclaimed" value={d.unclaimed} sign="−" note="explained by mint state" />
            <Row label="Δ Cold storage" value={d.coldStorage} sign="−" note="operator-declared" />
            <Row label="Δ Mint fees collected" value={d.mintFees} sign="−" note="known income" />
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
            accounts for. Remaining delta is node routing income, rounding of routing fees by the
            mint or other that might need attention.
          </p>
        </>
      )}
    </DeltaCardShell>
  )
}

/**
 * The balance-sheet view of the same window: what the assets did, what the
 * liabilities did.
 *
 * Deliberately toneless. Reserves and outstanding ecash normally move TOGETHER
 * and in the same direction — a melt lowers both, a mint raises both — so a fall
 * in either is business as usual, not a warning. What carries judgement is
 * whether they moved together, which is what the closing line shows: the two
 * sides plus proofs pending reconstruct Δ own capital exactly, so a divergence
 * between assets and liabilities has nowhere to hide.
 */
export function ReservesChangeCard({ data, error, stale }: DeltaCardProps) {
  const d = data?.deltas

  return (
    <DeltaCardShell
      title="Change in reserves and issued ecash"
      data={data}
      error={error}
      stale={stale}
    >
      {d && (
        <>
          <dl className="text-sm">
            <Row label="Δ Reserves" value={d.reserves} note="LND + cold storage + mint on-chain" />
            <Row label="Δ Ecash issued" value={d.ecashIssued} sign="−" note="outstanding liability" />
            <Row label="Δ Proofs pending" value={d.proofsPending} sign="+" note="locked in a melt" />
            <div
              className="mt-1 flex items-baseline justify-between gap-3 pt-2"
              style={{ borderTop: '1px solid var(--viz-axis)' }}
            >
              <dt className="pl-7 font-medium" style={{ color: 'var(--viz-ink)' }}>
                = Δ Own capital
              </dt>
              <dd className="font-mono font-semibold tabular-nums" style={{ color: 'var(--viz-ink)' }}>
                {formatSatSigned(d.ownCapital)}
              </dd>
            </div>
          </dl>

          <p className="mt-2 text-xs" style={{ color: 'var(--viz-muted)' }}>
            Assets against liabilities. These normally move together — a melt lowers both, a mint
            raises both — so direction alone means little; it is the two sides diverging that
            changes own capital.
          </p>
        </>
      )}
    </DeltaCardShell>
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
