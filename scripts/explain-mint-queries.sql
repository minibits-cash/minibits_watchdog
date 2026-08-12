-- ============================================================================
-- Minibits Watchdog — cost estimation for mint queries
-- ============================================================================
--
-- EXPLAIN without ANALYZE: the planner produces estimates WITHOUT executing
-- anything. No rows are read, no I/O is done against the heap. Completely safe
-- on the production cluster.
--
-- Purpose: decide which verification queries are affordable before running any
-- of them, and confirm the per-tick collector queries really do use indexes
-- rather than falling back to sequential scans.
--
-- Read the top-line `cost=` and `rows=` of each plan. A "Seq Scan" on proof,
-- blind_signature or mint_quote is the expensive case.
-- ============================================================================

-- ── Per-tick collector queries: these MUST be index scans ────────────────────

EXPLAIN
SELECT keyset_id, total_issued, total_redeemed, fee_collected FROM keyset_amounts;

EXPLAIN
SELECT keyset_id, count(*), sum(amount) FROM proof WHERE state = 'PENDING' GROUP BY keyset_id;

-- PENDING only: PAID is terminal in CDK (58% of rows), so including it turns
-- this into a full sequential scan instead of a small index scan.
EXPLAIN
SELECT unit, state, count(*), sum(amount), sum(fee_reserve)
FROM melt_quote WHERE state = 'PENDING' GROUP BY unit, state;

EXPLAIN
SELECT count(*), sum(inputs_amount) FROM melt_request;

EXPLAIN
SELECT operation_kind, state, count(*) FROM saga_state GROUP BY 1, 2;

-- ── "Total unclaimed": no index supports amount_paid > amount_issued ─────────

EXPLAIN
SELECT unit, count(*), sum(amount_paid - amount_issued)
FROM mint_quote WHERE amount_paid > amount_issued GROUP BY unit;

-- Cheaper alternative via the two narrow append-only ledger tables rather than
-- mint_quote's wide rows. Also cross-checks that mint_quote's running
-- amount_paid / amount_issued columns agree with the event log.

EXPLAIN
SELECT count(*), sum(amount) FROM mint_quote_payments;

EXPLAIN
SELECT count(*), sum(amount) FROM mint_quote_issued;

-- ── Ledger drift check: the expensive tier, intended to run rarely ───────────

EXPLAIN
SELECT keyset_id, count(*), sum(amount) FROM blind_signature WHERE c IS NOT NULL GROUP BY keyset_id;

EXPLAIN
SELECT keyset_id, count(*), sum(amount) FROM proof WHERE state = 'SPENT' GROUP BY keyset_id;
