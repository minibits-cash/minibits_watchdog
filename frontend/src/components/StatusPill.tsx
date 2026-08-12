import clsx from 'clsx'
import type { SourceStatus } from '@/lib/types'

const STYLES: Record<SourceStatus, string> = {
  OK: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  SKIPPED: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  UNREACHABLE: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  ERROR: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  TIMEOUT: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
}

export function StatusPill({ status }: { status: SourceStatus | null }) {
  if (!status) {
    return <span className="text-zinc-400">—</span>
  }
  return (
    <span
      className={clsx(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
        STYLES[status] ?? STYLES.ERROR,
      )}
    >
      {status}
    </span>
  )
}
