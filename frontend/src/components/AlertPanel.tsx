import type { Alert, Severity } from '@/lib/types'
import { formatAge } from '@/lib/format'

/**
 * Status colours are reserved tokens and always ship with an icon AND a label,
 * never colour alone — three of the four status steps are deliberately sub-3:1
 * on the light surface, and the icon+label pairing is the mitigation.
 */
const STATUS: Record<Severity, { colour: string; icon: string; label: string }> = {
  CRITICAL: { colour: 'var(--status-critical)', icon: '●', label: 'Critical' },
  WARNING: { colour: 'var(--status-warning)', icon: '▲', label: 'Warning' },
  INFO: { colour: 'var(--status-good)', icon: '■', label: 'Info' },
}

export function AlertPanel({ alerts }: { alerts: Alert[] }) {
  const firing = alerts.filter((a) => a.status === 'FIRING')

  return (
    <section
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--viz-border)', background: 'var(--viz-surface)' }}
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--viz-ink)' }}>
          Alerts
        </h2>
        <span className="text-xs" style={{ color: 'var(--viz-ink-2)' }}>
          {firing.length === 0 ? 'none firing' : `${firing.length} firing`}
        </span>
      </header>

      {firing.length === 0 ? (
        <p className="flex items-center gap-2 text-sm" style={{ color: 'var(--viz-ink-2)' }}>
          <span aria-hidden style={{ color: 'var(--status-good)' }}>
            ●
          </span>
          No active alerts.
        </p>
      ) : (
        <ul className="space-y-3">
          {firing.map((a) => {
            const s = STATUS[a.severity] ?? STATUS.WARNING
            return (
              <li key={a.id} className="flex gap-2.5">
                <span aria-hidden className="mt-0.5 shrink-0 text-xs" style={{ color: s.colour }}>
                  {s.icon}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xs font-semibold" style={{ color: s.colour }}>
                      {s.label}
                    </span>
                    <span className="text-sm" style={{ color: 'var(--viz-ink)' }}>
                      {a.title}
                    </span>
                  </div>
                  {a.detail && (
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--viz-ink-2)' }}>
                      {a.detail}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--viz-muted)' }}>
                    {a.ruleId} · fired {formatAge(a.firedAt)} · notified {a.notifyCount}×
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
