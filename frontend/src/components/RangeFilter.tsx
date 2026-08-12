/**
 * Shared time-range control.
 *
 * Extracted so the charts and the change card look and behave identically —
 * two visually different range pickers on one page would read as two different
 * kinds of control.
 */
export interface RangeOption {
  label: string
  value: number
}

export function RangeFilter({
  label,
  options,
  value,
  onChange,
  trailing,
}: {
  label: string
  options: RangeOption[]
  value: number
  onChange: (v: number) => void
  trailing?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs" style={{ color: 'var(--viz-muted)' }}>
        {label}
      </span>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className="rounded-md px-2.5 py-1 text-xs"
          style={{
            border: '1px solid var(--viz-border)',
            background: value === o.value ? 'var(--viz-surface)' : 'transparent',
            color: value === o.value ? 'var(--viz-ink)' : 'var(--viz-ink-2)',
            fontWeight: value === o.value ? 600 : 400,
          }}
        >
          {o.label}
        </button>
      ))}
      {trailing && <span className="ml-auto text-xs" style={{ color: 'var(--viz-muted)' }}>{trailing}</span>}
    </div>
  )
}
