import { useState, ReactNode } from 'react'
import { formatSat } from '@/lib/format'
import type { LndSnapshot, MintSnapshot, Reconciliation } from '@/lib/types'

/**
 * The reconciliation identity, term by term, with drill-downs.
 *
 * An equation rather than a chart on purpose: this is an accounting identity,
 * not a magnitude comparison. A waterfall would dress up arithmetic as a trend.
 *
 * This is the view that makes an alert diagnosable — it shows WHICH term moved,
 * which is the first question after "reserve drift" fires, and the drill-downs
 * answer the second: which component of that term.
 */
export function ReconciliationPanel({
  r,
  lnd,
  mint,
}: {
  r: Reconciliation | null
  lnd: LndSnapshot | null
  mint: MintSnapshot | null
}) {
  if (!r) {
    return (
      <Card>
        <h2 className="mb-1 text-sm font-semibold" style={{ color: 'var(--viz-ink)' }}>
          Reconciliation
        </h2>
        <p className="text-sm" style={{ color: 'var(--viz-ink-2)' }}>
          No reconciliation yet — it needs both LND and the mint to succeed in the same tick.
        </p>
      </Card>
    )
  }

  const reserves = BigInt(r.totalNodeBalance) + BigInt(r.coldStorage) + BigInt(r.mintOnchain)

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--viz-ink)' }}>
        Reconciliation ({r.unit})
      </h2>

      <dl className="text-sm">
        <Term
          sign=""
          label="Reserves"
          value={reserves.toString()}
          drill={
            lnd ? (
              <>
                <SubRow label="LND channel local" value={lnd.channelLocal} />
                <SubRow
                  label="LND channel unsettled (in-flight HTLCs)"
                  value={lnd.channelUnsettledLocal}
                  muted
                  note="incoming only; excluded from the total"
                />
                <SubRow label="LND on-chain confirmed" value={lnd.onchainConfirmed} />
                <SubRow label="LND on-chain unconfirmed" value={lnd.onchainUnconfirmed} />
                <SubRow
                  label="LND on-chain anchor reserve"
                  value={lnd.onchainReservedAnchor}
                  muted
                  note="already inside LND on-chain confirmed"
                />
                <SubRow label="LND limbo (force-closing)" value={lnd.limbo} />
                <SubRow
                  label="Cold storage (declared)"
                  value={r.coldStorage}
                  note="declared via COLD_STORAGE_RESERVES"
                />
                <SubRow
                  label="Mint on-chain wallet (BDK)"
                  value={r.mintOnchain}
                  note={
                    mint
                      ? `${mint.onchainQuotes} quotes · ledger-derived, interim`
                      : 'ledger-derived, interim'
                  }
                />
                {/*
                  Shown as already-applied, not as a term to subtract: it is part
                  of the wallet-balance estimate above. Lightning has no
                  counterpart because LND's local_balance drops at HTLC send.
                */}
                {mint?.onchainInflight && BigInt(mint.onchainInflight) > 0n ? (
                  <SubRow
                    label="↳ less on-chain melts in flight"
                    value={mint.onchainInflight}
                    muted
                    note={`${mint.onchainInflightCount} broadcast, unsettled · already deducted above`}
                  />
                ) : null}
                {mint?.onchainInflightStale && BigInt(mint.onchainInflightStale) > 0n ? (
                  <SubRow
                    label="↳ stuck beyond trust window"
                    value={mint.onchainInflightStale}
                    note={`${mint.onchainInflightStaleCount} melt(s) · NOT deducted — figure may be overstated`}
                  />
                ) : null}
              </>
            ) : null
          }
        />

        {/*
          Not an arithmetic term — these sats ARE inside Reserves. The payment
          landed, so the mint holds them; what has not happened is the issuance of
          the ecash they were paid for. Shown as an encumbrance so it reads as
          "part of the above is spoken for" rather than as another line to add or
          subtract.

          Covers BOTH payment methods. The total is ledger-derived (the ledger
          tables have no payment_method column), while the on-chain share comes
          from mint_quote — so the Lightning figure is stated as the remainder
          rather than measured separately, and cannot disagree with the total.
        */}
        <OfWhich
          label="of which unclaimed"
          value={r.unclaimed}
          note={unclaimedSplit(r.unclaimed, mint?.unclaimedOnchain)}
        />

        <Term
          sign="−"
          label="Ecash issued"
          value={r.mintBalance}
          hint="issued − redeemed"
          drill={
            mint?.keysetBreakdown?.length ? (
              <>
                {mint.keysetBreakdown.map((k) => {
                  const outstanding = (BigInt(k.issued) - BigInt(k.redeemed)).toString()
                  return (
                    <SubRow
                      key={k.keysetId}
                      label={`${k.keysetId.slice(0, 16)}${k.keysetId.length > 16 ? '…' : ''}`}
                      value={outstanding}
                      note={`${k.active ? 'active' : 'inactive'} · fee ${k.inputFeePpk} ppk`}
                    />
                  )
                })}
              </>
            ) : null
          }
        />

        {/*
          Only rendered when declared. At zero — the default — an extra line
          asserting "nothing here" is noise in an equation meant to be read at a
          glance.

          A liability the mint will never settle is not a liability, so removing
          it raises equity. Kept as its own term rather than netted off "Ecash
          issued" above, so that figure remains exactly what the mint database
          reports and stays checkable against it.
        */}
        {BigInt(r.provablyUnspendable ?? 0) !== 0n && (
          <Term
            sign="+"
            label="Unspendable ecash"
            value={r.provablyUnspendable}
            hint="declared never-redeemable (PROVABLY_UNSPENDABLE_ECASH)"
          />
        )}

        <Term
          sign="+"
          label="Proofs pending"
          value={r.proofsPending}
          hint="locked in an in-flight melt"
        />

        <div className="mt-1 pt-2" style={{ borderTop: '1px solid var(--viz-axis)' }}>
          <Term
            sign=""
            label="Own capital"
            value={r.ownCapital}
            emphasis
            drill={
              <>
                <SubRow
                  label="Mint fees collected"
                  value={r.mintFeesCollected}
                  note="cumulative; taken by burning ecash"
                />
                <SubRow
                  label="Unclaimed obligations"
                  value={r.unclaimed}
                  note="INCLUDED here, but arguably owed — see below"
                />
                {BigInt(r.provablyUnspendable ?? 0) !== 0n && (
                  <SubRow
                    label="Unspendable ecash"
                    value={r.provablyUnspendable}
                    note="declared never-redeemable; raises equity"
                  />
                )}
                <SubRow
                  label="Unattributed"
                  value={(
                    BigInt(r.ownCapital) -
                    BigInt(r.mintFeesCollected) -
                    BigInt(r.unclaimed) -
                    BigInt(r.provablyUnspendable ?? 0)
                  ).toString()}
                  muted
                  note="routing income, fee rounding, channel reserve, initial capital"
                />
              </>
            }
          />
          <OfWhich
            label="net of unclaimed"
            value={(BigInt(r.ownCapital) - BigInt(r.unclaimed)).toString()}
            note="conservative: treats unclaimed as owed"
          />
        </div>
      </dl>

      <p className="mt-2 text-xs" style={{ color: 'var(--viz-muted)' }}>
        A level, not a signal — it accumulates routing fee income, rounding of Lightning fees up
        to whole sats, channel reserve and initial capitalisation. Only its change matters.
      </p>

    </Card>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--viz-border)', background: 'var(--viz-surface)' }}
    >
      {children}
    </section>
  )
}

/** A top-level term, expandable when it has components worth seeing. */
function Term({
  sign,
  label,
  value,
  hint,
  drill,
  emphasis,
}: {
  sign: string
  label: string
  value: string
  hint?: string
  drill?: ReactNode
  /** The result line of the identity, not one of its inputs. */
  emphasis?: boolean
}) {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(drill)

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        <dt className="flex items-baseline gap-2">
          <span className="w-3 shrink-0 text-right font-mono" style={{ color: 'var(--viz-muted)' }}>
            {sign}
          </span>
          {expandable ? (
            <button
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex items-baseline gap-1.5 text-left"
              style={{ color: 'var(--viz-ink-2)' }}
            >
              <span aria-hidden className="text-[10px]" style={{ color: 'var(--viz-muted)' }}>
                {open ? '▾' : '▸'}
              </span>
              <span className="underline decoration-dotted underline-offset-2">{label}</span>
            </button>
          ) : (
            <span className="pl-3.5" style={{ color: 'var(--viz-ink-2)' }}>
              {label}
            </span>
          )}
          {hint && (
            <span className="text-xs" style={{ color: 'var(--viz-muted)' }}>
              {hint}
            </span>
          )}
        </dt>
        <dd
          className={`font-mono tabular-nums${emphasis ? ' font-semibold' : ''}`}
          style={{ color: 'var(--viz-ink)' }}
        >
          {formatSat(value)}
        </dd>
      </div>
      {open && drill && <div className="mb-1 ml-7 border-l pl-3" style={{ borderColor: 'var(--viz-grid)' }}>{drill}</div>}
    </div>
  )
}

function SubRow({
  label,
  value,
  note,
  muted,
}: {
  label: string
  value: string
  note?: string
  muted?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <dt className="flex items-baseline gap-2">
        <span style={{ color: muted ? 'var(--viz-muted)' : 'var(--viz-ink-2)' }}>{label}</span>
        {note && <span style={{ color: 'var(--viz-muted)' }}>{note}</span>}
      </dt>
      <dd
        className="font-mono tabular-nums"
        style={{ color: muted ? 'var(--viz-muted)' : 'var(--viz-ink-2)' }}
      >
        {formatSat(value)}
      </dd>
    </div>
  )
}

/**
 * An encumbrance on the term above, not a term of its own.
 *
 * Deliberately given no sign glyph and indented under the preceding line, so it
 * cannot be misread as something to add or subtract. It marks a portion of the
 * value above that is already committed.
 */
/**
 * Splits unclaimed into its two payment methods for the note line.
 *
 * On-chain is the measured half and Lightning is the remainder, because the two
 * numbers come from different places in CDK: the total from the append-only
 * ledger tables, the on-chain share from `mint_quote`. Deriving Lightning by
 * subtraction keeps the parts summing to the displayed total even if those two
 * sources disagree — with the residue landing on Lightning, where a discrepancy
 * is at least visible, rather than silently splitting the difference.
 *
 * Degrades to the unsplit wording when the mint snapshot is missing, which is
 * the case whenever the mint source failed but a reconciliation still exists
 * from an earlier tick.
 */
function unclaimedSplit(total: string, onchain: string | null | undefined): string {
  const base = 'paid but ecash not yet issued'
  if (onchain === null || onchain === undefined) return base

  const chain = BigInt(onchain)
  const ln = BigInt(total) - chain

  // Only ever one method in play — no point naming a split that is 0 / everything.
  if (chain === 0n) return `${base} · all on Lightning`
  if (ln <= 0n) return `${base} · all on-chain`

  return `${base} · Lightning ${formatSat(ln.toString())} · on-chain ${formatSat(onchain)}`
}

function OfWhich({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 pl-7 text-xs">
      <dt className="flex items-baseline gap-2">
        <span aria-hidden style={{ color: 'var(--viz-muted)' }}>
          ↳
        </span>
        <span style={{ color: 'var(--viz-ink-2)' }}>{label}</span>
        {note && <span style={{ color: 'var(--viz-muted)' }}>{note}</span>}
      </dt>
      <dd className="font-mono tabular-nums" style={{ color: 'var(--viz-ink-2)' }}>
        {formatSat(value)}
      </dd>
    </div>
  )
}


