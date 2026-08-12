-- ============================================================================
-- Minibits Watchdog — mint accounting verification (LIGHT)
-- ============================================================================
--
-- Tier 1 only: every query here is a tiny table or an index-assisted lookup on
-- a small subset. No sequential scans of the large tables. Safe to run against
-- the production cluster at any time.
--
-- Estimated cost:
--   keyset_amounts    2 rows      32 kB   — full read, trivial
--   keyset            3 rows      64 kB   — full read, trivial
--   saga_state        0 rows      64 kB   — full read, trivial
--   melt_request      8 rows      32 kB   — full read, trivial
--   proof             state='PENDING' via idx_proof_state_operation
--   melt_quote        state IN (PENDING,PAID) via melt_quote_state_index
--
-- This is exactly the set of queries the collector will run every 5 minutes.
-- Running it is therefore also a load rehearsal for the production path.
--
-- WHAT IT GIVES US
--   'Mint balance'   -> sheet column "Mint balance"
--   'Proofs pending' -> sheet column "Proofs pending"
--
-- WHAT IT DOES NOT GIVE US
--   'Total unclaimed' needs mint_quote, which has no index supporting
--   amount_paid > amount_issued. See verify-mint-unclaimed.sql.
--   Ledger drift needs full scans. See verify-mint-accounting.sql.
-- ============================================================================

WITH k AS (
    SELECT id, unit FROM keyset
),

ledger AS (
    SELECT k.unit,
           sum(a.total_issued)::bigint   AS issued,
           sum(a.total_redeemed)::bigint AS redeemed,
           sum(a.fee_collected)::bigint  AS fees
    FROM keyset_amounts a
    JOIN k ON k.id = a.keyset_id
    GROUP BY k.unit
),

pending_proofs AS (
    SELECT k.unit,
           count(*)                           AS n,
           coalesce(sum(p.amount), 0)::bigint AS total
    FROM proof p
    JOIN k ON k.id = p.keyset_id
    WHERE p.state = 'PENDING'
    GROUP BY k.unit
),

-- PENDING only. In CDK, PAID is a TERMINAL success state for a melt quote —
-- 58% of melt_quote rows are PAID, so including it would sweep in every
-- completed melt in history and force a full sequential scan.
inflight_melts AS (
    SELECT unit, state,
           count(*)                              AS n,
           coalesce(sum(amount), 0)::bigint      AS total,
           coalesce(sum(fee_reserve), 0)::bigint AS fee_reserve
    FROM melt_quote
    WHERE state = 'PENDING'
    GROUP BY unit, state
),

rows_out AS (

    SELECT 1 AS ord, 'A. Keysets' AS section,
           format('%s  unit=%s  active=%s  fee_ppk=%s', id, unit, active, coalesce(input_fee_ppk, 0)) AS metric,
           '' AS unit, '' AS value
    FROM keyset

    UNION ALL SELECT 2, 'B. CDK ledger', 'total_issued',   unit, issued::text   FROM ledger
    UNION ALL SELECT 2, 'B. CDK ledger', 'total_redeemed', unit, redeemed::text FROM ledger
    UNION ALL SELECT 2, 'B. CDK ledger', 'fee_collected',  unit, fees::text     FROM ledger

    UNION ALL SELECT 3, 'C. In-flight', 'proofs PENDING amount', unit, total::text FROM pending_proofs
    UNION ALL SELECT 3, 'C. In-flight', 'proofs PENDING count',  unit, n::text     FROM pending_proofs
    UNION ALL SELECT 3, 'C. In-flight', 'melt_quote ' || state || ' amount', unit, total::text FROM inflight_melts
    UNION ALL SELECT 3, 'C. In-flight', 'melt_quote ' || state || ' count',  unit, n::text     FROM inflight_melts
    UNION ALL SELECT 3, 'C. In-flight', 'melt_quote ' || state || ' fee_reserve', unit, fee_reserve::text FROM inflight_melts

    UNION ALL SELECT 4, 'D. Transient tables', 'saga_state rows', '-', count(*)::text FROM saga_state
    UNION ALL SELECT 4, 'D. Transient tables', 'melt_request rows', '-', count(*)::text FROM melt_request
    UNION ALL SELECT 4, 'D. Transient tables', 'melt_request inputs_amount', '-',
                      coalesce(sum(inputs_amount), 0)::text FROM melt_request
    UNION ALL SELECT 4, 'D. Transient tables', 'melt_request inputs_fee', '-',
                      coalesce(sum(inputs_fee), 0)::text FROM melt_request

    -- E. Sheet values ---------------------------------------------------------
    UNION ALL
    SELECT 5, 'E. SHEET VALUES', 'Mint balance (issued - redeemed)', l.unit,
           (l.issued - l.redeemed)::text
    FROM ledger l
    UNION ALL
    SELECT 5, 'E. SHEET VALUES', 'Proofs pending', p.unit, p.total::text
    FROM pending_proofs p
)

SELECT ord, section, metric, unit, value
FROM rows_out
ORDER BY ord, section, metric, unit;
