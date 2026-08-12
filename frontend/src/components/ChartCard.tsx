import { useState, ReactNode } from 'react'

/**
 * Chart container.
 *
 * Owns the table-view toggle because every chart needs a WCAG-clean twin — a
 * tooltip must enhance a chart, never be the only route to a value.
 *
 * Height is not fixed on the plot alone: the container grows to include the
 * x-axis band, otherwise the axis labels get cropped into a nested scrollbar.
 */
export function ChartCard({
  title,
  subtitle,
  children,
  table,
  stale,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  table: ReactNode
  stale?: boolean
}) {
  const [showTable, setShowTable] = useState(false)

  return (
    <section
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--viz-border)', background: 'var(--viz-surface)' }}
    >
      <header className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--viz-ink)' }}>
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--viz-ink-2)' }}>
              {subtitle}
            </p>
          )}
        </div>
        <button
          onClick={() => setShowTable((v) => !v)}
          className="shrink-0 rounded-md px-2 py-1 text-xs"
          style={{ color: 'var(--viz-ink-2)', border: '1px solid var(--viz-border)' }}
          aria-pressed={showTable}
        >
          {showTable ? 'Chart' : 'Table'}
        </button>
      </header>

      {/* Hold the previous render at reduced opacity while refetching rather
          than flashing a skeleton, which would jump the layout. */}
      <div style={{ opacity: stale ? 0.55 : 1, transition: 'opacity 150ms' }}>
        {showTable ? table : children}
      </div>
    </section>
  )
}
