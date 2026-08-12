import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAlerts, getCollectorStatus, getLatestObservation, getTimeseries } from '@/lib/api'
import { formatAge, formatSat } from '@/lib/format'
import { StatusPill } from '@/components/StatusPill'
import { StatTile } from '@/components/StatTile'
import { ChartCard } from '@/components/ChartCard'
import { AlertPanel } from '@/components/AlertPanel'
import { ReconciliationPanel } from '@/components/ReconciliationPanel'
import { ChangeCard } from '@/components/ChangeCard'
import { RangeFilter, RangeOption } from '@/components/RangeFilter'
import {
  OwnCapitalChart,
  ReservesVsEcashChart,
  SeriesTable,
  toRows,
} from '@/components/ReserveCharts'
import type { Alert, CollectorStatus, Observation, TimeseriesPoint } from '@/lib/types'

const POLL_MS = 30_000

const RANGES: RangeOption[] = [
  { label: '6h', value: 6 },
  { label: '24h', value: 24 },
  { label: '7d', value: 168 },
  { label: '30d', value: 720 },
]

export default function Dashboard() {
  const [hours, setHours] = useState(24)
  const [status, setStatus] = useState<CollectorStatus | null>(null)
  const [observation, setObservation] = useState<Observation | null>(null)
  const [points, setPoints] = useState<TimeseriesPoint[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [refetching, setRefetching] = useState(false)

  const refresh = useCallback(
    async (h: number) => {
      setRefetching(true)
      try {
        const [s, o, ts, al] = await Promise.all([
          getCollectorStatus(),
          getLatestObservation(),
          getTimeseries(h),
          getAlerts('FIRING'),
        ])
        setStatus(s)
        setObservation(o.observation)
        setPoints(ts.points)
        setAlerts(al.alerts)
        setError(null)
        setLoadedAt(new Date())
      } catch (e: any) {
        setError(String(e?.message ?? e))
      } finally {
        setRefetching(false)
      }
    },
    [],
  )

  useEffect(() => {
    void refresh(hours)
    const t = setInterval(() => void refresh(hours), POLL_MS)
    return () => clearInterval(t)
  }, [refresh, hours])

  const rows = useMemo(() => toRows(points), [points])
  const r = observation?.reconciliation ?? null

  // Endpoints of the real (non-gap) data, so the headline change is not computed
  // from a synthetic gap marker.
  const real = rows.filter((x) => !x.gap && x.ownCapital !== null)

  /**
   * Own capital falling is not in itself bad news.
   *
   * When a deposit that was already received gets minted into ecash, own capital
   * drops and `unclaimed` drops with it — routine operation, not a loss. Colouring
   * that red trains you to ignore the colour.
   *
   * Because `ownCapitalNet = ownCapital − unclaimed`, the change in the NET line
   * is exactly the part unclaimed does not account for. So the tile keys its tone
   * and its wording off that, not off the raw change.
   */
  const change = (() => {
    if (real.length < 2) return null
    const a = real[0]
    const b = real[real.length - 1]
    const own = (b.ownCapital as number) - (a.ownCapital as number)
    const unexplained = (b.ownCapitalNet as number) - (a.ownCapitalNet as number)
    return { own, unexplained, unclaimed: own - unexplained }
  })()

  const rangeLabel = RANGES.find((x) => x.value === hours)?.label ?? `${hours}h`

  /** Outstanding ecash over the same window. Raw change — no floor, since this is
   *  volume rather than an alerting signal, and hiding a small real movement
   *  would lose information for no benefit. */
  const ecashChange =
    real.length >= 2
      ? (real[real.length - 1].ecashIssued as number) - (real[0].ecashIssued as number)
      : null

  /** Absorbs msat→sat rounding; real thresholds are calibrated in the rules. */
  const MATERIAL_SAT = 1_000

  const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toLocaleString('en-US')}`

  const capitalDelta = !change
    ? null
    : change.unexplained < -MATERIAL_SAT
      ? { text: `${signed(change.unexplained)} unexplained over ${rangeLabel}`, tone: 'bad' as const }
      : change.unexplained > MATERIAL_SAT
        ? { text: `${signed(change.unexplained)} over ${rangeLabel}`, tone: 'good' as const }
        : Math.abs(change.unclaimed) > MATERIAL_SAT
          ? {
              text: `${signed(change.unclaimed)} in unclaimed over ${rangeLabel}`,
              tone: 'neutral' as const,
            }
          : { text: `no material change over ${rangeLabel}`, tone: 'neutral' as const }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--viz-ink)' }}>
          Minibits Watchdog
        </h1>
        <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--viz-muted)' }}>
          <span>
            LND <StatusPill status={status?.latestLndStatus ?? null} /> mint{' '}
            <StatusPill status={status?.latestMintStatus ?? null} />
          </span>
          <span>last observation {formatAge(status?.latestObservedAt)}</span>
          <span>{loadedAt ? `refreshed ${loadedAt.toLocaleTimeString()}` : 'loading…'}</span>
        </div>
      </header>

      {error && (
        <div
          className="mb-5 rounded-lg px-4 py-3 text-sm"
          style={{
            border: '1px solid var(--status-critical)',
            color: 'var(--status-critical)',
          }}
        >
          <span aria-hidden>● </span>
          Cannot reach the watchdog API: {error}
        </div>
      )}

      <div className="mb-5">
        <AlertPanel alerts={alerts} />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Reserves"
          value={
            r
              ? formatSat(
                  (
                    BigInt(r.totalNodeBalance) +
                    BigInt(r.coldStorage) +
                    BigInt(r.mintOnchain)
                  ).toString(),
                )
              : '—'
          }
          hint={
            r && BigInt(r.mintOnchain) > 0n
              ? `incl. ${formatSat(r.mintOnchain)} mint on-chain`
              : undefined
          }
        />
        {/*
          Deliberately toneless. Outstanding ecash rising or falling is business
          volume, not a health signal — colouring growth green would assert that
          more circulating ecash is good, which is not this tool's judgement, and
          status colours are reserved for conditions that are actually good or bad.
        */}
        <StatTile
          label="Ecash issued"
          value={formatSat(r?.mintBalance)}
          delta={ecashChange === null ? null : `${signed(ecashChange)} over ${rangeLabel}`}
          deltaTone="neutral"
        />
        <StatTile
          label="Own capital"
          value={formatSat(r?.ownCapital)}
          delta={capitalDelta?.text ?? null}
          deltaTone={capitalDelta?.tone ?? 'neutral'}
          hint={
            change && Math.abs(change.unclaimed) > MATERIAL_SAT && capitalDelta?.tone !== 'neutral'
              ? `${signed(change.unclaimed)} of it in unclaimed`
              : undefined
          }
        />
        <StatTile
          label="Proofs pending"
          value={formatSat(r?.proofsPending)}
          hint={`${observation?.mints?.[0]?.proofsPendingCount ?? 0} proofs in flight`}
        />
      </div>

      {/* One filter row above both charts — they always render the same slice.
          The change card carries its own, because "what moved recently" is asked
          over a different horizon than the one you want plotted. */}
      <div className="mb-3">
        <RangeFilter
          label="Range"
          options={RANGES}
          value={hours}
          onChange={setHours}
          trailing={`${rows.length} observations`}
        />
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Reserves vs ecash issued"
          subtitle="LND + cold storage + mint on-chain, against outstanding ecash liabilities"
          stale={refetching}
          table={<SeriesTable rows={rows} columns={['reserves', 'ecashIssued']} />}
        >
          <ReservesVsEcashChart rows={rows} />
        </ChartCard>

        <ChartCard
          title="Own capital"
          subtitle="Reserves − ecash issued + proofs pending. The gap between the lines is unclaimed."
          stale={refetching}
          table={<SeriesTable rows={rows} columns={['ownCapital', 'ownCapitalNet']} />}
        >
          <OwnCapitalChart rows={rows} />
        </ChartCard>
      </div>

      <div className="mb-5">
        <ChangeCard unit={r?.unit ?? 'sat'} />
      </div>

      <ReconciliationPanel
        r={r}
        lnd={observation?.lnd ?? null}
        mint={observation?.mints?.[0] ?? null}
      />

      {observation?.mintError && (
        <p className="mt-4 text-xs" style={{ color: 'var(--status-critical)' }}>
          <span aria-hidden>● </span>
          Last mint read failed: {observation.mintError}
        </p>
      )}
      {observation?.lndError && (
        <p className="mt-1 text-xs" style={{ color: 'var(--status-critical)' }}>
          <span aria-hidden>● </span>
          Last LND read failed: {observation.lndError}
        </p>
      )}
    </main>
  )
}
