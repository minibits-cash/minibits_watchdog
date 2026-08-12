/**
 * Stat tile: a single current value, optionally with a change.
 *
 * The value uses proportional figures, not tabular-nums — equal-width digits
 * make a large standalone number look loose. tabular-nums is reserved for
 * columns that align vertically.
 */
export function StatTile({
  label,
  value,
  unit = 'sat',
  delta,
  deltaTone,
  hint,
}: {
  label: string
  value: string
  unit?: string
  delta?: string | null
  deltaTone?: 'good' | 'bad' | 'neutral'
  hint?: string
}) {
  const deltaColour =
    deltaTone === 'good'
      ? 'var(--status-good-text)'
      : deltaTone === 'bad'
        ? 'var(--status-critical)'
        : 'var(--viz-ink-2)'

  return (
    <div
      className="rounded-xl border p-3"
      style={{ borderColor: 'var(--viz-border)', background: 'var(--viz-surface)' }}
    >
      <div className="text-xs" style={{ color: 'var(--viz-ink-2)' }}>
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold leading-none" style={{ color: 'var(--viz-ink)' }}>
          {value}
        </span>
        <span className="text-xs" style={{ color: 'var(--viz-muted)' }}>
          {unit}
        </span>
      </div>
      {delta && (
        <div className="mt-1.5 text-xs" style={{ color: deltaColour }}>
          {delta}
        </div>
      )}
      {hint && (
        <div className="mt-1 text-xs" style={{ color: 'var(--viz-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}
