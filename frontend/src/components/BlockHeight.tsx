import clsx from 'clsx'

/**
 * The chain height the watchdog last observed.
 *
 * Two heights exist and they are not the same measurement:
 *
 *   - LND's `blockHeight` is the watchdog's own view of the tip. Everything the
 *     node reports is as of this height.
 *   - the mint's BDK wallet reports the height it has scanned to. On-chain
 *     deposit recognition runs off that, so a wallet lagging the tip means
 *     deposits confirmed in between are not visible to the mint yet — which
 *     would otherwise read as a missing deposit rather than a stale scan.
 *
 * The tip is the headline; the wallet appears only once it is behind far enough
 * that the `mint_wallet_sync` rule would fire on it. Flagging a smaller gap here
 * would put an amber chip in the header with nothing in the alert panel to
 * explain it — a one-block difference is usually just the two reads landing
 * either side of a new block. The exact gap is always in the tooltip.
 *
 * Kept in step with mintRules.ts `mint_wallet_sync` (maxBlocksBehind, default 6),
 * including its precondition: LND's height is a reference only when LND itself
 * is caught up, since an unsynced node makes any lag it implies meaningless.
 */
const WALLET_MAX_BLOCKS_BEHIND = 6

export function BlockHeight({
  tip,
  syncedToChain,
  walletHeight,
}: {
  tip: number | null | undefined
  syncedToChain: boolean | null | undefined
  walletHeight: number | null | undefined
}) {
  if (tip === null || tip === undefined) {
    return (
      <span title="No block height: the last LND read did not succeed">
        block <span className="text-zinc-400">—</span>
      </span>
    )
  }

  const stale = syncedToChain === false
  const lag = !stale && walletHeight != null ? tip - walletHeight : null
  const walletBehind = lag !== null && lag > WALLET_MAX_BLOCKS_BEHIND

  const title = [
    `LND synced to block ${tip.toLocaleString('en-US')}`,
    stale ? 'LND reports it is NOT synced to chain — this height is behind the tip' : null,
    walletHeight == null
      ? 'Mint BDK wallet height not measured'
      : `Mint BDK wallet scanned to ${walletHeight.toLocaleString('en-US')}` +
        (lag === null
          ? ''
          : lag === 0
            ? ' (level)'
            : ` (${lag > 0 ? `${lag} behind` : `${-lag} ahead`})`),
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span>block</span>
      <span
        className={clsx(
          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
          stale
            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
            : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
        )}
      >
        {tip.toLocaleString('en-US')}
        {stale && ' (unsynced)'}
      </span>
      {walletBehind && (
        <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          wallet −{lag}
        </span>
      )}
    </span>
  )
}
