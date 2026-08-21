-- Decompose mint_wallet_ledger_divergence over its own alert window.
--
-- Runs against the WATCHDOG's database, not the mint's:
--     yarn --cwd backend sql scripts/verify-wallet-ledger-gap.sql DATABASE_URL
--
-- Cheap by construction — one table, one tick per row, no joins into cdk_mint —
-- so it is safe on the production cluster in a way verify-mint-accounting.sql
-- is not.
--
-- The rule alerts on the gap MOVING, and the gap is a difference of five
-- independently moving terms. When the alert looks wrong the question is never
-- "is the gap large" but "which column stepped", and this is the only view that
-- answers it. Read the columns left to right against the alert's arithmetic:
--
--     gap = wallet - ledger - awaiting_credit - dust - operator_liquidity
--
-- A step in `wallet` alone is real and worth chasing. A step in `ledger` is the
-- accumulator reseeding — expected after a data reset, and not a movement of
-- funds. A step in `dust` or `operator_liquidity` is the deposit classifier
-- catching up on a transaction it could not attribute earlier, which lowers the
-- gap without anything having left the wallet.
SELECT
    o."observedAt",
    r."mintOnchain"            / 1000 AS wallet,
    r."mintOnchainLedger"      / 1000 AS ledger,
    r."depositsAwaitingCredit" / 1000 AS awaiting_credit,
    r."dustReceived"           / 1000 AS dust,
    r."depositsUnattributed"   / 1000 AS operator_liquidity,
    (
        r."mintOnchain"
        - COALESCE(r."mintOnchainLedger", 0)
        - r."depositsAwaitingCredit"
        - r."dustReceived"
        - r."depositsUnattributed"
    ) / 1000 AS gap
FROM "Reconciliation" r
JOIN "Observation" o ON o.id = r."observationId"
WHERE r."mintOnchainBasis" = 'WALLET'
  AND o."observedAt" >= now() - interval '24 hours'
ORDER BY r.id ASC;
