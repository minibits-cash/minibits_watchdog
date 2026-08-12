-- ============================================================================
-- Minibits Watchdog — CDK mint accounting verification
-- ============================================================================
--
-- Reproduces the mint-side columns of the manual tracking sheet directly from
-- the CDK schema, and cross-checks CDK's running ledger (keyset_amounts)
-- against the underlying rows.
--
-- Single statement, returns (ord, section, metric, unit, value). Run in
-- Beekeeper and copy the grid.
--
-- ⚠ COST: this DOES scan data — full sequential scans of `proof` and
-- `blind_signature`, the two largest tables in the mint schema.
--
-- The test cdk_mint lives on the PRODUCTION cluster, so these scans compete
-- with production for I/O and shared buffers. Run it at a quiet hour, or
-- against a replica or restored backup.
--
-- For routine verification use scripts/verify-mint-light.sql instead: it covers
-- Mint balance and Proofs pending using only index lookups and tiny tables, and
-- is the exact query set the collector runs every 5 minutes.
--
-- Run scripts/explain-mint-queries.sql first if you want planner cost estimates
-- without executing anything.
--
-- What only THIS script provides: the ledger drift cross-check (section G),
-- verifying CDK's running keyset_amounts totals against the underlying rows.
--
-- ⚠ SECTION G ALSO SETTLES THE `+ Proofs pending` QUESTION (SPEC.md §3.1).
--
--   redeemed: ledger − proof(SPENT) == 0
--     → total_redeemed counts only SPENT proofs. PENDING is still carried as a
--       liability, so adding Proofs pending back is CORRECT.
--
--   redeemed: ledger − proof(SPENT) == the PENDING total
--     → PENDING proofs are already counted as redeemed. Adding them back
--       double-discounts; the `+ Proofs pending` term must be REMOVED.
--
-- Getting this wrong fails silently: own capital spikes upward during every
-- melt, and positive spikes do not trip the drift rules. Run this before
-- trusting reserve figures in production.
--
-- WHAT TO COMPARE
--   'Mint balance'     -> sheet column "Mint balance"
--   'Proofs pending'   -> sheet column "Proofs pending"
--   'Total unclaimed'  -> sheet column "Total unclaimed (PAID, not ISSUED)"
-- ============================================================================

WITH k AS (
    SELECT id, unit FROM keyset
),

-- CDK's own running ledger (2 rows). The candidate cheap read.
ledger AS (
    SELECT k.unit,
           sum(a.total_issued)::bigint   AS issued,
           sum(a.total_redeemed)::bigint AS redeemed,
           sum(a.fee_collected)::bigint  AS fees
    FROM keyset_amounts a
    JOIN k ON k.id = a.keyset_id
    GROUP BY k.unit
),

-- Raw issuance. Split on signed vs unsigned: blind_signature.c and signed_time
-- are nullable, so rows may be reserved before they are actually signed.
-- Which of these matches ledger.issued tells us when CDK counts issuance.
raw_issued AS (
    SELECT k.unit,
           coalesce(sum(b.amount), 0)::bigint                                    AS all_rows,
           coalesce(sum(b.amount) FILTER (WHERE b.c IS NOT NULL), 0)::bigint     AS signed_only,
           count(*)                                                              AS n_all,
           count(*) FILTER (WHERE b.c IS NULL)                                   AS n_unsigned
    FROM blind_signature b
    JOIN k ON k.id = b.keyset_id
    GROUP BY k.unit
),

-- Raw proof state breakdown.
proofs AS (
    SELECT k.unit, p.state,
           count(*)                         AS n,
           coalesce(sum(p.amount), 0)::bigint AS total
    FROM proof p
    JOIN k ON k.id = p.keyset_id
    GROUP BY k.unit, p.state
),

-- Mint quotes: paid but not yet issued (the sheet's "Total unclaimed").
unclaimed AS (
    SELECT unit,
           count(*) FILTER (WHERE amount_paid > amount_issued)                                  AS n,
           coalesce(sum(amount_paid - amount_issued)
                    FILTER (WHERE amount_paid > amount_issued), 0)::bigint                      AS total,
           coalesce(sum(amount_issued - amount_paid)
                    FILTER (WHERE amount_issued > amount_paid), 0)::bigint                      AS over_issued
    FROM mint_quote
    GROUP BY unit
),

melts AS (
    SELECT unit, state,
           count(*)                              AS n,
           coalesce(sum(amount), 0)::bigint      AS total,
           coalesce(sum(fee_reserve), 0)::bigint AS fee_reserve
    FROM melt_quote
    GROUP BY unit, state
),

sagas AS (
    SELECT operation_kind, state, count(*) AS n FROM saga_state GROUP BY 1, 2
),

rows_out AS (

    -- A. CDK running ledger --------------------------------------------------
    SELECT 1 AS ord, 'A. CDK ledger' AS section, 'total_issued'   AS metric, unit, issued::text   AS value FROM ledger
    UNION ALL SELECT 1, 'A. CDK ledger', 'total_redeemed', unit, redeemed::text FROM ledger
    UNION ALL SELECT 1, 'A. CDK ledger', 'fee_collected',  unit, fees::text     FROM ledger

    -- B. Raw cross-check -----------------------------------------------------
    UNION ALL SELECT 2, 'B. Raw cross-check', 'blind_signature sum (all rows)',  unit, all_rows::text    FROM raw_issued
    UNION ALL SELECT 2, 'B. Raw cross-check', 'blind_signature sum (signed)',    unit, signed_only::text FROM raw_issued
    UNION ALL SELECT 2, 'B. Raw cross-check', 'blind_signature rows',            unit, n_all::text       FROM raw_issued
    UNION ALL SELECT 2, 'B. Raw cross-check', 'blind_signature rows UNSIGNED',   unit, n_unsigned::text  FROM raw_issued
    UNION ALL SELECT 2, 'B. Raw cross-check', 'proof sum where SPENT',           unit, total::text       FROM proofs WHERE state = 'SPENT'

    -- C. Proof states --------------------------------------------------------
    UNION ALL SELECT 3, 'C. Proof states', 'state=' || state || ' amount', unit, total::text FROM proofs
    UNION ALL SELECT 3, 'C. Proof states', 'state=' || state || ' count',  unit, n::text     FROM proofs

    -- D. Quotes --------------------------------------------------------------
    UNION ALL SELECT 4, 'D. Quotes', 'mint_quote unclaimed amount',  unit, total::text       FROM unclaimed
    UNION ALL SELECT 4, 'D. Quotes', 'mint_quote unclaimed count',   unit, n::text           FROM unclaimed
    UNION ALL SELECT 4, 'D. Quotes', 'mint_quote OVER-issued (!!)',  unit, over_issued::text FROM unclaimed
    UNION ALL SELECT 4, 'D. Quotes', 'melt_quote ' || state || ' amount',      unit, total::text       FROM melts
    UNION ALL SELECT 4, 'D. Quotes', 'melt_quote ' || state || ' count',       unit, n::text           FROM melts
    UNION ALL SELECT 4, 'D. Quotes', 'melt_quote ' || state || ' fee_reserve', unit, fee_reserve::text FROM melts

    -- E. In-flight sagas -----------------------------------------------------
    UNION ALL SELECT 5, 'E. Sagas', operation_kind || ' / ' || state, '-', n::text FROM sagas

    -- F. Derived sheet values ------------------------------------------------
    UNION ALL
    SELECT 6, 'F. SHEET VALUES', 'Mint balance (issued - redeemed)', l.unit,
           (l.issued - l.redeemed)::text
    FROM ledger l
    UNION ALL
    SELECT 6, 'F. SHEET VALUES', 'Proofs pending', p.unit, p.total::text
    FROM proofs p WHERE p.state = 'PENDING'
    UNION ALL
    SELECT 6, 'F. SHEET VALUES', 'Total unclaimed', u.unit, u.total::text
    FROM unclaimed u

    -- G. Ledger drift: MUST be zero ------------------------------------------
    UNION ALL
    SELECT 7, 'G. LEDGER DRIFT (must be 0)', 'issued: ledger - raw(signed)', l.unit,
           (l.issued - r.signed_only)::text
    FROM ledger l JOIN raw_issued r ON r.unit = l.unit
    UNION ALL
    SELECT 7, 'G. LEDGER DRIFT (must be 0)', 'issued: ledger - raw(all)', l.unit,
           (l.issued - r.all_rows)::text
    FROM ledger l JOIN raw_issued r ON r.unit = l.unit
    UNION ALL
    SELECT 7, 'G. LEDGER DRIFT (must be 0)', 'redeemed: ledger - proof(SPENT)', l.unit,
           (l.redeemed - coalesce(p.total, 0))::text
    FROM ledger l
    LEFT JOIN proofs p ON p.unit = l.unit AND p.state = 'SPENT'
)

SELECT ord, section, metric, unit, value
FROM rows_out
ORDER BY ord, section, metric, unit;
