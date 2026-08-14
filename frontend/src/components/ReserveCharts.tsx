import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TimeseriesPoint } from '@/lib/types'

/**
 * Chart marks follow the spec: 2px round-capped lines, hairline SOLID gridlines
 * one step off the surface (recharts defaults to dashed, which reads as
 * "threshold" when it is only a grid), no dot on every point, and an endpoint
 * marker with a 2px surface ring so it stays legible where it crosses a line.
 *
 * Colours are CSS custom properties rather than literals, so light/dark swap
 * without a JS theme listener.
 */

export interface Row {
  t: number
  label: string
  /** null marks a break in observation — see insertGaps. */
  reserves: number | null
  ecashIssued: number | null
  ownCapital: number | null
  ownCapitalNet: number | null
  proofsPending: number | null
  gap?: true
}

const SAT = (msat: string | null): number => (msat === null ? 0 : Number(BigInt(msat) / 1000n))

/** Collection interval; gaps beyond a few multiples mean the watchdog was not running. */
const EXPECTED_INTERVAL_MS = 5 * 60_000
const GAP_THRESHOLD_MS = EXPECTED_INTERVAL_MS * 3

/**
 * Break the line wherever collection stopped.
 *
 * Joining across a gap would draw a straight segment through hours nobody
 * observed, implying the value moved smoothly when we simply have no idea what
 * it did. Recharts breaks a line on a null value, so a synthetic null row at the
 * midpoint leaves a visible discontinuity — the honest rendering of missing data.
 */
function insertGaps(rows: Row[]): Row[] {
  const out: Row[] = []
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && rows[i].t - rows[i - 1].t > GAP_THRESHOLD_MS) {
      out.push({
        t: Math.round((rows[i].t + rows[i - 1].t) / 2),
        label: 'no data',
        reserves: null,
        ecashIssued: null,
        ownCapital: null,
        ownCapitalNet: null,
        proofsPending: null,
        gap: true,
      })
    }
    out.push(rows[i])
  }
  return out
}

export function toRows(points: TimeseriesPoint[]): Row[] {
  const rows: Row[] = points.map((p) => ({
    t: new Date(p.t).getTime(),
    label: new Date(p.t).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    reserves: SAT(p.totalNodeBalance) + SAT(p.coldStorage) + SAT(p.mintOnchain),
    ecashIssued: SAT(p.mintBalance),
    ownCapital: SAT(p.ownCapital),
    // The conservative reading: unclaimed treated as a deferred obligation
    // rather than equity. Both are plotted so the gap between them is visible.
    ownCapitalNet: SAT(p.ownCapital) - SAT(p.unclaimed),
    proofsPending: SAT(p.proofsPending),
  }))
  return insertGaps(rows)
}

const compact = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : Math.abs(v) >= 1_000
      ? `${(v / 1_000).toFixed(0)}k`
      : String(v)

const axisProps = {
  stroke: 'var(--viz-axis)',
  tick: { fill: 'var(--viz-muted)', fontSize: 11 },
  tickLine: false,
} as const

/**
 * Shared as PROPS, deliberately not as wrapper components.
 *
 * Recharts identifies its children by component type, so `<CartesianGrid>` and
 * `<XAxis>` must appear literally inside `<LineChart>`. Wrapping them in custom
 * components makes Recharts ignore them entirely — which silently removed the
 * axis (no tick labels) and left the tooltip with no x-scale, so its `label`
 * defaulted to 0 and every point read as 1 Jan 1970.
 */
const GRID_PROPS = {
  // Solid hairline, never dashed.
  stroke: 'var(--viz-grid)',
  strokeDasharray: '0',
  vertical: false,
} as const

const TIME_AXIS_PROPS = {
  dataKey: 't',
  type: 'number' as const,
  scale: 'time' as const,
  domain: ['dataMin', 'dataMax'] as [string, string],
  tickFormatter: (t: number) =>
    new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  minTickGap: 48,
  height: 30,
  tickMargin: 8,
  ...axisProps,
}

/**
 * A y-domain that follows the data rather than anchoring at zero.
 *
 * These are all large, slow-moving balances. Anchored at zero, a day's movement
 * is a few pixels of a tall column and every line reads as flat — the chart shows
 * magnitude, which is already in the KPI tiles, and hides the trend, which is the
 * only thing a chart adds.
 *
 * Zero is not dropped unconditionally, though. It is the solvency boundary, so it
 * is forced back into view once the data comes near it: a suppressed axis that
 * crops out the very line being approached would be worse than a flat one. The
 * test keys off the SMALLEST series, since that is what reaches zero first.
 */
function valueDomain(values: (number | null)[]): {
  domain: [number | 'auto', 'auto']
  nearZero: boolean
} {
  const present = values.filter((v): v is number => v !== null)
  if (present.length === 0) return { domain: ['auto', 'auto'], nearZero: false }

  const min = Math.min(...present)
  const max = Math.max(...present)
  const nearZero = min < Math.abs(max) * 0.25

  return { domain: nearZero ? [0, 'auto'] : ['auto', 'auto'], nearZero }
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
}: any) {
  if (!active || !payload?.length) return null
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-lg"
      style={{
        background: 'var(--viz-surface)',
        border: '1px solid var(--viz-border)',
        color: 'var(--viz-ink)',
      }}
    >
      <div className="mb-1" style={{ color: 'var(--viz-ink-2)' }}>
        {new Date(label).toLocaleString()}
      </div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: p.stroke }}
          />
          <span style={{ color: 'var(--viz-ink-2)' }}>{series[p.dataKey] ?? p.dataKey}</span>
          <span className="ml-auto font-medium tabular-nums">
            {Number(p.value).toLocaleString('en-US')} sat
          </span>
        </div>
      ))}
    </div>
  )
}

const LINE = {
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  dot: false,
  isAnimationActive: false,
}

/** Endpoint marker: ≥8px with a 2px ring in the surface colour. */
const endDot = (color: string) => ({
  r: 4,
  fill: color,
  stroke: 'var(--viz-surface)',
  strokeWidth: 2,
})

/**
 * Two series of comparable magnitude, so they share ONE axis. Never a dual axis:
 * two arbitrary scales on one plot invent a correlation the data does not have.
 */
export function ReservesVsEcashChart({ rows }: { rows: Row[] }) {
  const series = { reserves: 'Reserves', ecashIssued: 'Ecash issued' }

  // Keyed off `ecashIssued` alone: reserves exceed it by own capital, so it is
  // always the lower line. Reserves approaching zero is a different failure from
  // the one this chart is for — here the meaningful boundary is the two lines
  // CROSSING, which is visible without an axis anchored at zero.
  const { domain } = valueDomain(rows.map((r) => r.ecashIssued))

  return (
    <>
      {/* Legend is always present for ≥2 series, so identity is never colour-alone. */}
      <div className="mb-2 flex flex-wrap gap-4 text-xs" style={{ color: 'var(--viz-ink-2)' }}>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: 'var(--series-1)' }}
          />
          Reserves
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: 'var(--series-2)' }}
          />
          Ecash issued
        </span>
      </div>
      <ResponsiveContainer width="100%" height={296}>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...TIME_AXIS_PROPS} />
          <YAxis tickFormatter={compact} width={52} domain={domain} {...axisProps} />
          <Tooltip
            content={<ChartTooltip series={series} />}
            cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }}
          />
          <Line
            {...LINE}
            dataKey="reserves"
            stroke="var(--series-1)"
            activeDot={endDot('var(--series-1)')}
          />
          <Line
            {...LINE}
            dataKey="ecashIssued"
            stroke="var(--series-2)"
            activeDot={endDot('var(--series-2)')}
          />
        </LineChart>
      </ResponsiveContainer>
    </>
  )
}

/**
 * Own capital, with the conservative reading alongside it.
 *
 * The gap between the two lines IS the unclaimed balance — money received for
 * ecash that has not been issued. Plotting both makes that obligation legible as
 * a widening or narrowing band rather than a number you have to go and look up.
 *
 * The zero reference line is drawn only when the data approaches it. The buffer
 * normally sits far above zero, and forcing zero into view would flatten the
 * variation that matters; but zero is the solvency boundary, so it must appear
 * the moment it becomes relevant rather than being silently cropped out. It keys
 * off the LOWER series, since that is the one that reaches zero first.
 */
export function OwnCapitalChart({ rows }: { rows: Row[] }) {
  const series = { ownCapital: 'Own capital', ownCapitalNet: 'Net of unclaimed' }
  // Keyed off the NET line — the lower of the two, so it reaches zero first.
  const { domain, nearZero } = valueDomain(rows.map((r) => r.ownCapitalNet))

  return (
    <>
      {/* Two series, so a legend is mandatory — identity is never colour-alone. */}
      <div className="mb-2 flex flex-wrap gap-4 text-xs" style={{ color: 'var(--viz-ink-2)' }}>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: 'var(--series-1)' }}
          />
          Own capital
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: 'var(--series-2)' }}
          />
          Net of unclaimed
        </span>
      </div>
      <ResponsiveContainer width="100%" height={296}>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...TIME_AXIS_PROPS} />
          <YAxis
            tickFormatter={compact}
            width={52}
            domain={domain}
            {...axisProps}
          />
          <Tooltip
            content={<ChartTooltip series={series} />}
            cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }}
          />
          {nearZero && (
            <ReferenceLine
              y={0}
              stroke="var(--status-critical)"
              strokeWidth={1}
              label={{ value: 'insolvent', fill: 'var(--status-critical)', fontSize: 10 }}
            />
          )}
          <Line
            {...LINE}
            dataKey="ownCapital"
            stroke="var(--series-1)"
            activeDot={endDot('var(--series-1)')}
          />
          <Line
            {...LINE}
            dataKey="ownCapitalNet"
            stroke="var(--series-2)"
            activeDot={endDot('var(--series-2)')}
          />
        </LineChart>
      </ResponsiveContainer>
    </>
  )
}

/** The WCAG-clean twin. Every plotted value is reachable here without hovering. */
export function SeriesTable({ rows, columns }: { rows: Row[]; columns: (keyof Row)[] }) {
  const headings: Record<string, string> = {
    reserves: 'Reserves',
    ecashIssued: 'Ecash issued',
    ownCapital: 'Own capital',
    ownCapitalNet: 'Net of unclaimed',
    proofsPending: 'Proofs pending',
  }

  return (
    <div className="max-h-[260px] overflow-auto">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0" style={{ background: 'var(--viz-surface)' }}>
          <tr style={{ color: 'var(--viz-ink-2)' }}>
            <th className="py-1.5 pr-3 text-left font-medium">Time</th>
            {columns.map((c) => (
              <th key={String(c)} className="py-1.5 pl-3 text-right font-medium">
                {headings[String(c)] ?? String(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.t} style={{ borderTop: '1px solid var(--viz-grid)' }}>
              <td
                className="py-1.5 pr-3 whitespace-nowrap"
                style={{ color: r.gap ? 'var(--status-warning)' : 'var(--viz-ink-2)' }}
              >
                {r.gap ? '— collection gap —' : r.label}
              </td>
              {columns.map((c) => {
                const v = r[c]
                return (
                  <td key={String(c)} className="py-1.5 pl-3 text-right">
                    {typeof v === 'number' ? v.toLocaleString('en-US') : '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
