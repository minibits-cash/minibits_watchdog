# Minibits Watchdog

Internal monitoring for a Lightning node (LND) and a Cashu mint (CDK). It watches whether
the value backing the mint still matches the ecash the mint has issued, and alerts on
discrepancies, stuck operations and node problems.

- **[SPEC.md](SPEC.md)** — specification and reconciliation model.
- **[AGENTS.md](AGENTS.md)** — invariants and rationale to respect when changing the code.

> **Read-only by design.** The watchdog never writes to LND or the mint. It uses LND's
> `readonly.macaroon` and a `SELECT`-only Postgres role.

## What it measures

```
Reserves        = LND channel local + LND on-chain + limbo
                  + cold storage (declared) + mint on-chain wallet
Own capital     = Reserves − Ecash issued + Unspendable ecash (declared)
                  + Proofs pending
Remaining delta = Δ Own capital − Δ Unclaimed − Δ Deposits awaiting credit
                  − Δ Dust received − Δ Cold storage − Δ Unspendable ecash
                  − Δ Mint fees
```

**`Own capital`** is the mint's equity — reserves beyond what it owes. It is a level, and
only its change carries signal.

**`Remaining delta`** is the alertable number: every subtracted term is an explained
change, so what remains is unaccounted for.

`Unclaimed` (paid on Lightning or on-chain, ecash not yet issued) is counted as own
capital, with the net-of-unclaimed figure shown alongside it. See [SPEC.md §3](SPEC.md).

> ⚠ **Alert thresholds are not calibrated.** The `reserve_drift_*` rules and
> `mint_proofs_pending_high` use hand-picked numbers. Calibrate against real history
> before trusting them.

## Layout

```
backend/          Fastify + Prisma. Collector, rules, notifiers, API.
backend/scripts/  Operational tooling (SQL runner, LND probe, backfill).
frontend/         Next 14 + Tailwind. Dashboard, SSH-tunnel only.
scripts/          Read-only SQL for inspecting the mint database.
```

## Setup

Requires Node 24, **yarn 1.x (classic)**, and a Postgres instance for the watchdog's own
data — separate from the mint's.

`backend/yarn.lock` and `frontend/yarn.lock` are committed; `package-lock.json` is
gitignored.

### From the repository root

A root `package.json` delegates to both packages via `yarn --cwd`. It is a task runner
only — not a yarn workspace, so each package keeps its own `node_modules`.

```bash
yarn                 # installs backend + frontend (root postinstall)
yarn db:push         # create/update the watchdog schema
yarn build           # build both
yarn typecheck       # typecheck both

yarn start:backend           # or start:frontend
yarn dev                     # both in watch mode, one terminal
yarn dev:stop                # stop whatever this repo has running locally

yarn reset:data --yes --rules-only    # args pass through, no `--` needed
yarn sql ../scripts/verify-mint-light.sql
yarn probe:lnd
```

Arguments are forwarded through both yarn levels, so no `--` separator is required.
`yarn setup` is an alias for the install step.

`dev:stop` kills node processes running this project's entrypoints from a working
directory inside this repository. It does not kill by port.

In production run the two processes under separate service units rather than `yarn dev`.

### Backend

```bash
cd backend
cp .env.example .env       # every option is documented inline
yarn install
yarn prisma:updateDb       # push schema to the watchdog database
yarn start:dev
```

### Frontend

```bash
cd frontend
cp .env.example .env.local
yarn install
yarn build
yarn start                        # http://localhost:3006
```

`PORT` and `BACKEND_URL` are read at server start, so a second instance alongside a
tunnelled production one needs no rebuild:

```bash
PORT=3016 BACKEND_URL=http://127.0.0.1:3015 yarn start
```

### Mint database role

```sql
CREATE ROLE watchdog_ro LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE <mintdb> TO watchdog_ro;
GRANT USAGE ON SCHEMA public TO watchdog_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO watchdog_ro;

-- Survives future CDK migrations that add tables.
ALTER DEFAULT PRIVILEGES FOR ROLE <mint-owner> IN SCHEMA public
  GRANT SELECT ON TABLES TO watchdog_ro;

ALTER ROLE watchdog_ro SET default_transaction_read_only = on;
ALTER ROLE watchdog_ro SET statement_timeout = '30s';
```

> ⚠ **Dropping and recreating the mint database destroys these grants.** Roles and
> `pg_hba.conf` are cluster-level and survive; table grants and default privileges do not.
> Put these statements in the migration script. Without `ALTER DEFAULT PRIVILEGES`, a
> future migration adds a table the watchdog cannot read.

### Access

Both processes bind to loopback. The dashboard has no authentication — reach it over an
SSH tunnel:

```bash
ssh -L 3006:127.0.0.1:3006 <host>
```

One port only: the dashboard proxies `/api/*` to the backend server-side
(`frontend/src/pages/api/[...path].ts`), so the browser never contacts the API directly.

## Configuration

Everything is documented inline in `backend/.env.example`. The options most worth knowing:

| Variable | Purpose |
|---|---|
| `ENABLED_SOURCES` | `lnd,mint`. Credentials are required only for enabled sources. |
| `ENABLED_NOTIFIERS` | `ntfy,email`. A send succeeds if any transport does; partial failure is recorded. |
| `NTFY_REDACT_AMOUNTS`, `EMAIL_REDACT_AMOUNTS` | Strip figures from outbound alerts, per transport. Severity and subject survive. Both default to `true`. |
| `COLD_STORAGE_RESERVES` | Operator-declared reserves held outside the node. Treated as a declared movement and excluded from drift. |
| `PROVABLY_UNSPENDABLE_ECASH` | Operator-declared issued ecash that can never be redeemed. Added to own capital rather than deducted from ecash issued. Excluded from drift. |
| `MINT_RPC_HOST` | CDK management gRPC. Enables the WALLET basis for on-chain reserves (below). |
| `BITCOIN_RPC_URL` | Chain source for on-chain deposit attribution and co-spend detection. |
| `MINT_ONCHAIN_MIN_RECEIVE_SAT` | Must match the mint's `[bdk] min_receive_amount_sat`. Deposits below it are booked to own capital. |
| `INFLIGHT_MELT_MAX_AGE_SEC` | 24h. Beyond this an in-flight melt is no longer subtracted on the LEDGER basis. |
| `HEARTBEAT_URL` | Optional. Log markers work without it. |

Frontend (`frontend/.env.local`), read at server start — restart, no rebuild:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3006` | Dashboard port |
| `BACKEND_URL` | `http://127.0.0.1:3005` | Where `/api/*` is proxied |

## On-chain reserves: two bases

The mint's own on-chain (BDK) wallet balance comes from one of two sources. Which one is
in use is printed in the startup banner and recorded on every row in
`Reconciliation.mintOnchainBasis`.

| | **WALLET** (`MINT_RPC_HOST` set) | **LEDGER** (fallback) |
|---|---|---|
| Source | `WalletService.GetBalance` over CDK's management gRPC | Paid on-chain mint quotes, less booked payouts |
| Measures | the wallet | CDK's books |
| Detects an unbooked outflow | yes | **no** |

**Configure `MINT_RPC_HOST`.** The LEDGER basis verifies internal consistency, not
custody — it moves only when CDK writes a row, so coins leaving the wallet by a route CDK
did not book do not move it at all.

The WALLET basis uses `trusted_spendable` (confirmed + own unconfirmed change).

Run `yarn probe:mint-rpc` before deploying: it prints the wallet balance beside the ledger
estimate. Their difference lands as a one-off step in own capital at the changeover, and
above ~96,000 sat it trips `reserve_drift_long` once before ageing out of the 48h window.

On the WALLET basis the ledger estimate is still collected, into
`Reconciliation.mintOnchainLedger`; `mint_wallet_ledger_divergence` watches the *change*
in the gap between the two. If the wallet RPC is configured but does not answer, no
reconciliation row is written for that tick and `mint_wallet_rpc_unreachable` fires
CRITICAL.

> **Any change to what `Reserves` includes creates a step that reads as unexplained
> drift.** Either backfill history (`backend/scripts/backfill-onchain.mjs`) or record the
> change as a declared term.

## On-chain deposit attribution

Value entering the wallet is one of three things:

| | Origin | Liability | Treatment |
|---|---|---|---|
| **A** | User paying an on-chain mint quote | ecash owed | counts to unclaimed until issued |
| **B** | Operator, from outside the monitored perimeter | none | raises own capital |
| **C** | Operator, from the monitored LND on-chain wallet | none | nets to zero across the two pools, less fee |

CDK's wallet RPC cannot tell them apart, so `BITCOIN_RPC_URL` supplies the join: one
`getrawtransaction` gives the output addresses, matched against `mint_quote.request`. A
match is **A**; no match is **B/C**, which never touches unclaimed.

Deposits below `MINT_ONCHAIN_MIN_RECEIVE_SAT` are never credited by CDK and are booked
straight to own capital. They are tracked as a live set, so if CDK does credit one it
leaves the set as it enters unclaimed. Ages are measured from confirmation time, not from
when the watchdog first saw the transaction.

An on-chain deposit taking hours to be booked and issued is normal, and nothing warns on
it above the minimum. Such deposits are never released on a timer; the moment the mint
legitimately stops owing them is a keyset phase-out, declared through
`PROVABLY_UNSPENDABLE_ECASH`.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/introspect-mint-db.sql` | Schema discovery via psql. Catalog-only, safe on a live mint. |
| `scripts/introspect-mint-db-beekeeper.sql` | Same, as a single query for GUI clients. |
| `scripts/verify-mint-light.sql` | The per-tick query set. Index-assisted, negligible cost. |
| `scripts/explain-mint-queries.sql` | `EXPLAIN` without `ANALYZE`. Nothing executed. |
| `scripts/verify-mint-accounting.sql` | Full ledger cross-check. **Scans the two largest tables.** |
| `scripts/verify-wallet-ledger-gap.sql` | Decomposes `mint_wallet_ledger_divergence` per tick. Runs against `DATABASE_URL`, not the mint. |
| `backend/scripts/run-sql.mjs` | Runs a single-statement `.sql` file through the app's read-only path. |
| `backend/scripts/probe-lnd.ts` | `yarn probe:lnd` — reads LND through the real collector code path. |
| `backend/scripts/probe-mint-rpc.ts` | `yarn probe:mint-rpc` — BDK wallet balance beside the ledger estimate. |
| `backend/scripts/backfill-onchain.mjs` | One-off. Repairs history after a change to what `Reserves` includes. Dry-run by default. |
| `backend/scripts/reset-data.ts` | `yarn reset:data` — clear gathered data and/or reseed rule defaults. Dry-run by default. |
| `backend/scripts/check-funding-address.ts` | `yarn check-funding-address <addr>` — pre-flight before sending operator liquidity to the mint's wallet. |

## Resetting and rebuilding

The watchdog is a **derived store, not a system of record.** Everything it holds
comes from LND, the mint database, the BDK wallet or the chain, so clearing it is
a recovery option rather than a loss — `yarn reset:data` exists for exactly that.
Nothing should ever exist only here.

What a reset reconstructs on the following ticks:

| Rebuilt from | How complete |
|---|---|
| Reserve balances | Immediately — read live from LND and the wallet |
| `unclaimed`, ledger estimate | Fully — accumulator watermarks restart at 0, so on-chain quote discovery rescans from genesis |
| Wallet transaction cache | Fully — the build paginates when it is behind the wallet's reported total, rather than taking one page |
| Deposit classification | Only for blocks **above bitcoind's prune horizon** (~39 days at defaults) |

Two things do not come back, and both are history rather than state: the
observation series behind the charts and delta windows, and alert history.
Drift rules need two observations and a full window before they mean anything
again, so expect a warm-up period. Clearing `AlertState` also means any condition
still true re-fires and re-notifies on the next tick.

The one real constraint is the prune horizon. A deposit confirmed in a block
bitcoind no longer has cannot be classified, so it returns as `PENDING` — and an
uncredited inbound deposit in that state is counted as owed. Check that the
oldest uncredited deposit is inside the horizon before resetting.

## Before trusting reserve figures in production

1. **Run `scripts/verify-mint-accounting.sql` once.** Section G verifies that CDK's
   running `keyset_amounts` has not drifted from the underlying rows, and settles whether
   the `+ Proofs pending` term is correct ([SPEC.md §3.1](SPEC.md)).
2. **Re-grant after any database recreate** (above).
3. **Compare the first production `Own capital` against your tracking spreadsheet.**

## Rules

23 rules, all tunable at runtime without a redeploy — see [Editing rule
configuration](#editing-rule-configuration). Logic lives in `backend/src/rules/`; only the
thresholds live in the database.

**`for`** is how many consecutive evaluations the condition must hold before firing (one
evaluation per collection tick, 5 minutes by default). **Kind** is `state` when the
condition is ongoing and its clearing is worth a notification, `event` when something
merely happened and there is nothing to clear.

### LND

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `lnd_unreachable` | CRITICAL | 2 | state | LND did not respond to the collector |
| `lnd_not_synced` | WARNING | 3 | state | Not synced to chain or graph |
| `lnd_force_close` | WARNING | 1 | state | Channels force-closing, or funds in limbo |
| `lnd_inactive_channels` | WARNING | 3 | state | More than `maxInactive` (3) channels inactive |

### Mint — database and ledger

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `mint_unreachable` | CRITICAL | 2 | state | The mint database read failed. Names the actual failure — permission, timeout, unreachable |
| `mint_over_issued` | CRITICAL | 1 | state | `amount_issued > amount_paid`: ecash created against an unpaid quote. A hard invariant; must always be zero |
| `mint_schema_access` | WARNING | 1 | state | A required table is unreadable, or an unrecognised one appeared |
| `mint_keyset_change` | INFO | 1 | event | Keyset count changed |
| `mint_proofs_pending_high` | WARNING | 3 | state | Proofs locked in `PENDING` above `thresholdSat` (500,000). **Uncalibrated** |
| `mint_melt_requests_stuck` | WARNING | 3 | state | More than `maxRows` (25) rows in the transient `melt_request` table |
| `mint_onchain_melt_stuck` | WARNING | 2 | state | A committed on-chain melt is unsettled past 24h, so it is no longer subtracted. Degrades the ledger cross-check, not reserves |

### Mint — BDK wallet

Only evaluated when `MINT_RPC_HOST` is set; they return "not evaluable" otherwise.

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `mint_wallet_rpc_unreachable` | CRITICAL | 3 | state | The wallet balance could not be read. No reconciliation row is written while it holds, so reserve drift is not being evaluated |
| `mint_chain_source_unreachable` | CRITICAL | 3 | state | bitcoind could not be reached. Deposits cannot be attributed to a quote while it holds, so any that arrive are counted as owed. Only evaluated when `BITCOIN_RPC_URL` is set; classification attempt budgets are not consumed, so it self-heals |
| `mint_wallet_ledger_divergence` | WARNING | 3 | state | The wallet-versus-ledger gap moved more than `thresholdSat` (50,000) over `windowHours` (24). Deposits awaiting credit, dust and operator liquidity are all subtracted, so the gap starts at zero and is unaffected by a deposit being reclassified |
| `mint_wallet_sync` | WARNING / CRITICAL | 3 | state | The wallet is more than `maxBlocksBehind` (6) behind LND's height, or on a network other than `expectedNetwork` (CRITICAL) |

### Mint — on-chain movements

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `mint_onchain_large_mint` | INFO | 1 | event | A deposit against a mint quote exceeds `fractionPct` (20) of the pre-movement wallet balance. Keyed on the payment, not the quote |
| `mint_onchain_large_melt` | INFO | 1 | event | A net outflow exceeds `fractionPct` (20) of the pre-movement balance. Keyed on the transaction |
| `mint_onchain_deposit_unattributed` | WARNING | 1 | event | A confirmed deposit paid no mint quote address. The mint owes no ecash for it, so it is excluded from unclaimed |
| `mint_onchain_dust_deposit` | WARNING | 1 | event | A confirmed deposit below `MINT_ONCHAIN_MIN_RECEIVE_SAT`, which CDK can never credit. Fires once on arrival |
| `mint_onchain_dust_cospent` | WARNING | 1 | event | The wallet spent a deposit it never credited, linking every co-input address to the mint via common-input-ownership. Needs `BITCOIN_RPC_URL` |

### Reconciliation

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `reserve_drift_short` | CRITICAL | 2 | state | `Remaining delta` falls below −20,000 sat/h over 6h |
| `reserve_drift_long` | WARNING | 3 | state | `Remaining delta` falls below −2,000 sat/h over 48h |

Both are rates computed from the window endpoints, not sums of per-tick deltas. Value
hysteresis: the bar to clear is higher than the bar to fire.
`expectedDriftSatPerHour` accounts for a non-zero baseline.

### Collector

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `collector_observation_gap` | WARNING | 1 | event | The interval between observations exceeded `toleranceMultiple` (3) × the collection interval |

> This rule is **not** a deadman's switch: it needs a later observation to notice the gap.
> See [Deadman's switch](#deadmans-switch-via-log-analysis).

## Deadman's switch via log analysis

The watchdog emits single-line JSON markers to stdout on every tick, written directly
rather than through the logger so `LOG_LEVEL` cannot suppress them:

```json
{"marker":"WATCHDOG_HEARTBEAT_OK","ts":"…","observationId":20,"lnd":"OK","mint":"OK","durationMs":955}
{"marker":"WATCHDOG_HEARTBEAT_FAIL","ts":"…","detail":"…"}
```

Configure **two** rules in the log analyser:

| Rule | Match | Severity |
|---|---|---|
| **Absence** | no `WATCHDOG_HEARTBEAT_OK` in 15 min (3× the 5-min cadence) | CRITICAL |
| Presence | any `WATCHDOG_HEARTBEAT_FAIL` | CRITICAL |

> The **absence** rule is the deadman's switch. A crashed, hung or OOM-killed watchdog
> emits no log line at all. The FAIL marker covers only what the watchdog is still alive
> enough to report.

## API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /api/collector/status` | Recency of last successful read per source |
| `GET /api/observations/latest` | Most recent observation with all snapshots |
| `GET /api/observations?from&to&limit` | Full observations over a range |
| `GET /api/timeseries?hours=` | Compact series for charting |
| `GET /api/deltas?minutes=` | Change in each term over a window, computed from endpoints |
| `POST /api/collector/run` | Trigger a tick manually |
| `GET /api/alerts?status=FIRING\|RESOLVED\|ALL` | Alert states |
| `GET /api/alerts/events` | Transition and delivery history |
| `GET /api/rules` | Registered rules and current tuning |
| `PATCH /api/rules/:ruleId` | Tune thresholds without a redeploy |
| `POST /api/notify/test` | Exercise every transport individually |
| `POST /api/heartbeat/test` | Verify the deadman's switch |

Monetary values are msat, serialised as **strings** — msat totals will outgrow a JS
double.

## Editing rule configuration

`RuleConfig` rows are seeded once from the code defaults in `backend/src/rules/*.ts` and
never updated afterwards, so tuning is never clobbered. The consequence is that **editing
a default in source has no effect on an existing database.**

**On a running deployment — `PATCH /api/rules/:ruleId`:**

```bash
curl -s http://127.0.0.1:3005/api/rules | jq        # current tuning for all rules

curl -s -X PATCH http://127.0.0.1:3005/api/rules/reserve_drift_short \
  -H 'content-type: application/json' \
  -d '{"params": {"toleranceSatPerHour": 50000}}'

curl -s -X PATCH http://127.0.0.1:3005/api/rules/lnd_inactive_channels \
  -H 'content-type: application/json' -d '{"enabled": false}'
```

Accepted fields: `enabled`, `severity`, `forEvaluations`, `clearEvaluations`,
`cooldownSeconds`, `notifyOnResolve`, `params`. Changes take effect on the next tick — no
restart.

`params` is stored wholesale rather than merged; the engine overlays stored params on the
rule's code defaults at evaluation time, so sending only the keys you want to override
works.

**For fresh deployments** — edit the rule module. That changes what new databases seed
with, and nothing else.

**To make changed code defaults apply to an existing database**, reseed the rules while
leaving the measurement history alone:

```bash
yarn reset:data --yes --rules-only
```

It truncates `RuleConfig` and reseeds by calling the engine's own `loadConfigs`, then
prints the resulting table. This **discards any tuning** done through the API. To reseed a
single rule instead, delete just its row and let the next tick recreate it.
