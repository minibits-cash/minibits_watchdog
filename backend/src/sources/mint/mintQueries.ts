/**
 * All SQL against the CDK mint lives here, so a CDK schema change across
 * releases has a single blast radius.
 *
 * Every query in the per-tick set is index-driven or reads a tiny table. The
 * mint database shares the production cluster, so anything that degrades to a
 * sequential scan of `proof`, `blind_signature` or `mint_quote` — the three large
 * tables — does not belong here. Measured: the whole per-tick set
 * runs in ~50 ms.
 */

/**
 * Per-keyset breakdown for the dashboard drill-down. The same rows as
 * KEYSET_TOTALS before aggregation, so it costs nothing extra.
 */
export const KEYSET_BREAKDOWN = `
    SELECT k.id                                    AS keyset_id,
           k.unit                                  AS unit,
           k.active                                AS active,
           coalesce(k.input_fee_ppk, 0)            AS input_fee_ppk,
           k.valid_from                            AS valid_from,
           coalesce(a.total_issued, 0)::bigint     AS issued,
           coalesce(a.total_redeemed, 0)::bigint   AS redeemed,
           coalesce(a.fee_collected, 0)::bigint    AS fee_collected
    FROM keyset k
    LEFT JOIN keyset_amounts a ON a.keyset_id = k.id
    ORDER BY k.valid_from
`

/** keyset_amounts is CDK's running ledger — one row per keyset. Joined for the unit. */
export const KEYSET_TOTALS = `
    SELECT k.unit                          AS unit,
           sum(a.total_issued)::bigint     AS issued,
           sum(a.total_redeemed)::bigint   AS redeemed,
           sum(a.fee_collected)::bigint    AS fee_collected,
           count(*)::int                   AS keysets_total,
           count(*) FILTER (WHERE k.active)::int AS keysets_active
    FROM keyset k
    LEFT JOIN keyset_amounts a ON a.keyset_id = k.id
    GROUP BY k.unit
`

/**
 * Proofs locked in an in-progress melt — the add-back term in the reconciliation
 * identity. Index: idx_proof_state_operation (state, operation_kind).
 */
export const PROOFS_PENDING = `
    SELECT k.unit                          AS unit,
           count(*)::int                   AS n,
           coalesce(sum(p.amount), 0)::bigint AS total
    FROM proof p
    JOIN keyset k ON k.id = p.keyset_id
    WHERE p.state = 'PENDING'
    GROUP BY k.unit
`

/**
 * In-flight melt quotes. PENDING only — PAID is a TERMINAL success state in CDK
 * and covers the majority of the table, so including it forces a full scan.
 *
 * Recorded as a metric, not used for stuck detection: this state accumulates
 * permanent residue — stale rows accumulated over many months, far outnumbering
 * the proofs genuinely locked. Stuck detection anchors on pending proofs instead.
 */
export const MELT_QUOTES_PENDING = `
    SELECT unit                              AS unit,
           count(*)::int                     AS n,
           coalesce(sum(amount), 0)::bigint  AS total,
           coalesce(sum(fee_reserve), 0)::bigint AS fee_reserve
    FROM melt_quote
    WHERE state = 'PENDING'
    GROUP BY unit
`

/** Transient operation tables. Both tiny; neither is reliably cleaned up. */
export const TRANSIENT_TABLES = `
    SELECT (SELECT count(*)::int FROM saga_state)                            AS sagas,
           (SELECT count(*)::int FROM melt_request)                          AS melt_requests,
           (SELECT coalesce(sum(inputs_amount), 0)::bigint FROM melt_request) AS melt_request_inputs
`

/**
 * Ledger tail sums for the watermark scheme. `id` is a monotonic integer PK with
 * a unique index, so both are index range scans.
 *
 * $1 = exclusive lower bound, $2 = inclusive upper bound (or NULL for open-ended).
 */
export function ledgerSum(table: 'mint_quote_payments' | 'mint_quote_issued'): string {
    return `
        SELECT coalesce(sum(amount), 0)::bigint AS total,
               count(*)::int                    AS n,
               coalesce(max(id), 0)::bigint     AS max_id
        FROM ${table}
        WHERE id > $1
          AND ($2::bigint IS NULL OR id <= $2::bigint)
    `
}

export function ledgerMaxId(table: 'mint_quote_payments' | 'mint_quote_issued'): string {
    return `SELECT coalesce(max(id), 0)::bigint AS max_id FROM ${table}`
}

/**
 * ── On-chain reserves, derived from CDK's own ledger ─────────────────────────
 *
 * INTERIM MEASURE. CDK will expose its integrated BDK wallet in a future
 * release; until then the balance is inferred from the mint's bookkeeping.
 *
 * The limitation is structural and worth stating plainly: this figure comes from
 * the same books the watchdog exists to audit, so it CANNOT detect on-chain
 * funds going missing. It verifies internal consistency, not custody. It also
 * misses any on-chain fee paid outside a melt — a UTXO consolidation, say —
 * so it drifts upward relative to reality over time.
 *
 * Balance = Σ deposits paid − Σ (melt payouts + their on-chain fees)
 *
 * Deposits use `mint_quote.amount_paid`, NOT `completed_operations.total_issued`:
 * the latter counts only *completed* operations, so it silently omits deposits
 * that have arrived on-chain but have not yet been minted into ecash.
 */

/** Discover on-chain quotes in a created_time window. Index: idx_mint_quote_created_time. */
export const ONCHAIN_QUOTE_DISCOVERY = `
    SELECT id, created_time
    FROM mint_quote
    WHERE created_time > $1
      AND created_time <= $2
      AND payment_method = 'onchain'
`

/**
 * Deposits received, re-read every tick by primary key.
 *
 * `amount_paid` changes after creation — a quote can be paid long after it was
 * made — so it can never be cached alongside the quote id.
 */
export const ONCHAIN_PAID_SUM = `
    SELECT coalesce(sum(amount_paid), 0)::bigint  AS paid,
           coalesce(sum(amount_issued), 0)::bigint AS issued,
           count(*)::int                           AS n
    FROM mint_quote
    WHERE id = ANY($1)
`

/**
 * On-chain melt outflow: what actually left the wallet, payout plus miner fee.
 *
 * Uses fee_reserve's *actual* counterpart from the operations ledger, not the
 * reserve itself — unused reserve is returned to the user as change ecash
 * (verified against a real melt: redeemed = payout + on-chain fee + change).
 *
 * Index: idx_completed_operations_kind_time (operation_kind, completed_at).
 */
export const ONCHAIN_MELT_OUT = `
    SELECT coalesce(sum(payment_amount + payment_fee), 0)::bigint AS out_total,
           count(*)::int                                          AS n,
           coalesce(max(completed_at), 0)::bigint                 AS max_completed_at
    FROM completed_operations
    WHERE operation_kind = 'melt'
      AND payment_method = 'onchain'
      AND completed_at > $1
      AND ($2::bigint IS NULL OR completed_at <= $2::bigint)
`

export const ONCHAIN_MELT_MAX_TS = `
    SELECT coalesce(max(completed_at), 0)::bigint AS max_completed_at
    FROM completed_operations
    WHERE operation_kind = 'melt'
`

/**
 * On-chain melts committed but not yet completed.
 *
 * These have left the BDK wallet already — the transaction is broadcast — but
 * `completed_operations` has no row until settlement, so the deposits-minus-
 * completions estimate above still counts them as reserves. On Lightning the
 * equivalent correction is free: the outgoing HTLC leaves `local_balance` the
 * moment it is sent, so LND's measurement reflects it natively. This query is
 * what gives the on-chain rail the same behaviour.
 *
 * Subtracts `amount + fee_reserve`, which is exactly `melt_request.inputs_amount`
 * — the proof total that `+ proofsPending` adds back — so the two cancel and own
 * capital stays flat across the whole melt. Measured against a real melt:
 * inputs 801,828 = payout 800,000 + actual fee 1,034 + ecash change 794.
 *
 * The actual miner fee is fixed at broadcast, but CDK persists it only in
 * `completed_operations.payment_fee` after settlement, so `fee_reserve` is the
 * in-flight upper bound. It understates the wallet by the change that returns.
 *
 * $1 = age cutoff. Older rows are reported separately rather than subtracted:
 * a dropped transaction returns the funds to the wallet, which would make the
 * correction a permanent understatement. Index: melt_quote_state_index.
 */
export const ONCHAIN_MELT_INFLIGHT = `
    SELECT coalesce(sum(amount + fee_reserve) FILTER (WHERE created_time > $1::bigint), 0)::bigint  AS committed,
           count(*) FILTER (WHERE created_time > $1::bigint)::int                                    AS n,
           coalesce(sum(amount + fee_reserve) FILTER (WHERE created_time <= $1::bigint), 0)::bigint AS stale,
           count(*) FILTER (WHERE created_time <= $1::bigint)::int                                   AS stale_n,
           coalesce(min(created_time), 0)::bigint                                                    AS oldest_created
    FROM melt_quote
    WHERE state = 'PENDING'
      AND payment_method = 'onchain'
`

/**
 * Permission and schema self-check. Catalog-only, no heap access.
 *
 * A CDK migration that adds a table the watchdog cannot read is a silent blind
 * spot — worse if the migration relocates accounting, since the collector would
 * keep reporting stale figures while appearing healthy.
 *
 * Privileges are tested by OID, not by name. `has_table_privilege(text, ...)`
 * parses its argument as an identifier, so an unquoted mixed-case or
 * reserved-word table name folds to lowercase and the function raises "relation
 * does not exist" — taking down the very check meant to diagnose such problems.
 * Every CDK table is lowercase today; the OID form removes the dependency on
 * that staying true.
 */
export const TABLE_ACCESS = `
    SELECT c.relname                            AS table_name,
           has_table_privilege(c.oid, 'SELECT') AS can_select
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY c.relname
`

/**
 * Which of these addresses belong to an on-chain mint quote?
 *
 * The discriminator between a user's mint payment and the operator moving
 * liquidity. `mint_quote.request` holds the bare deposit address for on-chain
 * quotes (verified: bech32 P2WPKH, 42 chars) and carries a UNIQUE index, so this
 * is an index lookup per address rather than a scan.
 *
 * Deliberately NOT filtered on quote state. A quote that has already been paid
 * and issued can receive a FURTHER payment to the same address — CDK allows it,
 * and a wallet is not prevented from doing it — so restricting to unpaid quotes
 * would misclassify the second payment as unattributed and drop it out of the
 * mint's liabilities.
 */
export const QUOTE_BY_ADDRESS = `
    SELECT id, request
    FROM mint_quote
    WHERE request = ANY($1)
      AND payment_method = 'onchain'
`

/**
 * Which of these transactions has CDK booked a payment for?
 *
 * `payment_id` is `txid:vout` and carries a UNIQUE index, but the vout is not
 * always known — without a chain source a deposit is never attributed to a
 * specific output. Matching on the txid prefix answers the question either way,
 * and a prefix is a range on a btree: EXPLAIN ANALYZE reports an Index Only Scan
 * at 0.5ms for three txids against 380k rows.
 *
 * Written as explicit bounds rather than `LIKE txid || ':%'` because the
 * pattern is not a constant, so the planner cannot derive index bounds from it
 * and falls back to a parallel sequential scan (measured: cost 17,849 vs 12).
 *
 * ⚠ The bounds assume byte ordering, where ':' (0x3A) precedes ';' (0x3B).
 * That holds under C / C.UTF-8 / POSIX. Callers must check the collation first
 * and use PAYMENTS_BOOKED_BY_TXID_PORTABLE otherwise — a locale that sorts
 * punctuation differently would silently return the wrong set, and "no payment
 * found" reads as an uncredited deposit, i.e. a liability that never clears.
 */
export const PAYMENTS_BOOKED_BY_TXID = `
    SELECT t.txid
    FROM unnest($1::text[]) AS t(txid)
    WHERE EXISTS (
        SELECT 1 FROM mint_quote_payments p
        WHERE p.payment_id >= t.txid || ':'
          AND p.payment_id <  t.txid || ';'
    )
`

/**
 * Collation-independent form of the above. Always correct, never indexed.
 *
 * Only reached on a mint database whose collation is not byte-ordered, and only
 * for the handful of deposits currently awaiting credit, so the sequential scan
 * is bounded by how many deposits are in flight rather than by table size.
 */
export const PAYMENTS_BOOKED_BY_TXID_PORTABLE = `
    SELECT DISTINCT split_part(payment_id, ':', 1) AS txid
    FROM mint_quote_payments
    WHERE split_part(payment_id, ':', 1) = ANY($1)
`

/**
 * Is the mint database ordered by byte value?
 *
 * Decides which of the two queries above is safe. Read once per process.
 */
export const DB_COLLATION = `SELECT current_setting('lc_collate') AS lc_collate`
