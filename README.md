# Minibits Watchdog

Internal monitoring for a Lightning node (LND) and a Cashu mint (CDK). It watches whether
the value backing the mint still matches the ecash the mint has issued, and alerts on
discrepancies, stuck operations and node problems.

Design and rationale live in **[SPEC.md](SPEC.md)** — it records *why* each decision was
made, including several that look wrong until you know what they prevent.

> **Read-only by design.** The watchdog never writes to LND or the mint. It uses LND's
> `readonly.macaroon` and a `SELECT`-only Postgres role, so a compromised watchdog cannot
> move funds or corrupt mint state. This is a hard boundary, not a default.

## What it measures

```
Reserves        = LND channel local + LND on-chain + limbo
                  + cold storage (declared) + mint on-chain wallet
Own capital     = Reserves − Ecash issued + Unspendable ecash (declared)
                  + Proofs pending
Remaining delta = Δ Own capital − Δ Unclaimed − Δ Cold storage
                  − Δ Unspendable ecash − Δ Mint fees
```

**`Own capital` is the mint's equity** — reserves beyond what it owes. It is a *level*, and
meaningless on its own: it accumulates routing income, fee rounding, channel reserve and
initial capitalisation. Only its change carries signal.

**`Remaining delta` is the alertable number.** Every subtracted term is an *explained*
change, so what remains is the part nothing accounts for. Known income is removed rather
than tolerated — earning fees while something drains an equal amount would otherwise read
as zero.

`Unclaimed` (paid on Lightning or on-chain, ecash not yet issued) is currently counted as
own capital, with the conservative net-of-unclaimed figure shown alongside it. See
[SPEC.md §3](SPEC.md).

## Status

| Step | State |
|---|---|
| 1. Scaffold | done |
| 2. Storage (Prisma schema) | done |
| 3. LND collector | done |
| 4. Mint collector | done |
| 5. Reconciliation | done |
| 6. Rule engine + alert lifecycle | done — 13 rules |
| 7. Notifiers (ntfy, email) + deadman's switch | done |
| 8. Dashboard | done |
| 9. Backfill + threshold calibration | **pending** |

> ⚠ **Alert thresholds are placeholders, not calibrated.** The `reserve_drift_*` rules fire
> on numbers chosen by hand, and `mint_proofs_pending_high` is deliberately set above the
> observed baseline, so it is currently insensitive rather than noisy. Calibrate against
> real history before trusting them either way.

## Layout

```
backend/          Fastify + Prisma. Collector, rules, notifiers, API.
backend/scripts/  Operational tooling (SQL runner, LND probe, backfill).
frontend/         Next 14 + Tailwind. Dashboard, SSH-tunnel only.
scripts/          Read-only SQL for inspecting the mint database.
SPEC.md           Specification and rationale.
```

## Setup

Requires Node 24, **yarn 1.x (classic)**, and a Postgres instance for the watchdog's own
data — **separate from the mint**, so watchdog load cannot affect the mint and the watchdog
survives (and can alert on) mint database failure.

This project uses yarn. `backend/yarn.lock` and `frontend/yarn.lock` are committed;
`package-lock.json` is gitignored so a stray `npm install` cannot quietly resolve a
different dependency tree.

### From the repository root

A root `package.json` delegates to both packages via `yarn --cwd`, so nothing needs a `cd`.
It is a task runner only — **not** a yarn workspace, so each package keeps its own
`node_modules` and neither dependency tree is hoisted.

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

Arguments are forwarded through both yarn levels, so unlike npm no `--` separator is
required. `yarn setup` is available as an explicit alias for the install step.

`dev:stop` matches on two conditions together — the process is a node runtime running one
of this project's entrypoints, **and** its working directory is inside this repository. It
deliberately does not kill by port: on a dev machine the production ports are held by the
SSH tunnel, so a port-based kill would drop the tunnel and make production look down.

In production run the two processes under separate service units rather than `yarn dev`,
so each can be restarted and logged independently.

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

`PORT` and `BACKEND_URL` are both read at server start, so a second instance
alongside a tunnelled production one needs no rebuild:

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

> ⚠ **Dropping and recreating the mint database destroys the grants.** Roles and
> `pg_hba.conf` are cluster-level and survive; table grants and default privileges live
> *inside* the database and do not. **Put these statements in the migration script** rather
> than relying on memory — the watchdog will refuse to collect and say exactly which tables
> it cannot read, but only after it has already stopped working.

The `ALTER DEFAULT PRIVILEGES` line is the one that is easy to skip and expensive to omit:
without it, a future migration adds a table the watchdog silently cannot read.

### Access

Both processes bind to loopback. The dashboard has no authentication by design — reach it
over an SSH tunnel:

```bash
ssh -L 3006:127.0.0.1:3006 <host>
```

**One port.** The dashboard proxies `/api/*` to the backend server-side
(`frontend/src/pages/api/[...path].ts`), so the browser never contacts the API
directly — no second tunnel, and no CORS in the browser path.

The proxy is a route handler rather than a `rewrites()` entry on purpose:
`rewrites()` is evaluated at **build** time and baked into `routes-manifest.json`,
so it cannot be retargeted by restart. A route handler reads `BACKEND_URL` per
request.

## Configuration highlights

Everything is documented inline in `backend/.env.example`. The options most worth knowing:

| Variable | Why it matters |
|---|---|
| `ENABLED_SOURCES` | `lnd,mint`. Credentials are required only for enabled sources, so disabling is explicit — an accidentally missing macaroon fails loudly instead of silently leaving the node unmonitored. |
| `ENABLED_NOTIFIERS` | `ntfy,email`. Enabling both gives delivery redundancy: a send succeeds if *any* transport does, and a partial failure is still recorded. |
| `NTFY_REDACT_AMOUNTS`, `EMAIL_REDACT_AMOUNTS` | Strip figures from outbound alerts, **per transport** — a public ntfy topic and a mailbox on your own domain are different exposures. Severity and subject survive, so alerts stay actionable. Both default to `true`: disclosure should be deliberate, so an unset variable errs toward privacy. |
| `COLD_STORAGE_RESERVES` | Operator-declared reserves held outside the node. Changing it is treated as a *declared* movement and excluded from drift — but the window between moving coins and updating it will alert, by design. |
| `PROVABLY_UNSPENDABLE_ECASH` | Operator-declared issued ecash that can never be redeemed (e.g. promises stranded by a mint migration). Added to *own capital* rather than deducted from *ecash issued*, so the measured liability stays checkable against the mint database. Also excluded from drift as a declared value. Only for provably unspendable ecash — dormant or unclaimed balances do not belong here. |
| `HEARTBEAT_URL` | Optional. Log markers work without it (below). |

Frontend (`frontend/.env.local`), both read at server start — restart, no rebuild:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3006` | Dashboard port |
| `BACKEND_URL` | `http://127.0.0.1:3005` | Where `/api/*` is proxied |

## Scripts

| Script | Purpose |
|---|---|
| `scripts/introspect-mint-db.sql` | Schema discovery via psql. Catalog-only, safe on a live mint. |
| `scripts/introspect-mint-db-beekeeper.sql` | Same, as a single query for GUI clients. |
| `scripts/verify-mint-light.sql` | The per-tick query set. Index-assisted, negligible cost — also a load rehearsal for the production path. |
| `scripts/explain-mint-queries.sql` | `EXPLAIN` without `ANALYZE`. Planner estimates only, nothing executed. |
| `scripts/verify-mint-accounting.sql` | Full ledger cross-check. **Scans the two largest tables** — see below. |
| `backend/scripts/run-sql.mjs` | Runs a single-statement `.sql` file through the app's own read-only path. |
| `backend/scripts/probe-lnd.ts` | `yarn probe:lnd` — reads LND through the real collector code path. |
| `backend/scripts/probe-mint-rpc.ts` | `yarn probe:mint-rpc` — reads the BDK wallet balance and prints it beside the ledger estimate it replaces. Run before switching bases. |
| `backend/scripts/backfill-onchain.mjs` | One-off. Repairs history after a change to what `Reserves` includes. Dry-run by default. |
| `backend/scripts/reset-data.ts` | `yarn reset:data` — clear gathered data and/or reseed rule defaults. Dry-run by default. |

## Before trusting reserve figures in production

1. **Run `scripts/verify-mint-accounting.sql` once.** Section G does two jobs: it verifies
   CDK's running `keyset_amounts` has not drifted from the underlying rows, **and** it
   settles whether the `+ Proofs pending` term is correct ([SPEC.md §3.1](SPEC.md)). That
   term is an unverified assumption whose failure mode is silent — it would inflate own
   capital during every melt, and a positive spike does not trip the drift rules.
2. **Re-grant after any database recreate** (above).
3. **Compare the first production `Own capital` against your tracking spreadsheet** — the
   end-to-end sanity check on the whole chain.

### On-chain reserves: two bases

The mint's own on-chain (BDK) wallet balance can come from either of two places, and they
are not interchangeable. Which one is in use is printed in the startup banner and recorded
on every row in `Reconciliation.mintOnchainBasis`.

| | **WALLET** (`MINT_RPC_HOST` set) | **LEDGER** (fallback) |
|---|---|---|
| Source | `WalletService.GetBalance` over CDK's management gRPC | Paid on-chain mint quotes, less booked payouts |
| Measures | the wallet | CDK's books |
| Detects an unbooked outflow | yes | **no** |

The LEDGER basis verifies internal consistency, **not custody**. It moves only when CDK
writes a row, so coins leaving the wallet by any route CDK did not book — a manual sweep,
an on-chain fee outside a melt, a bug — do not move it at all. Since undeclared outflow is
the single thing this tool exists to catch, that is a blind spot rather than a
conservative estimate. Configure `MINT_RPC_HOST`.

Verify the endpoint with `yarn probe:mint-rpc` before deploying: it prints the wallet
balance beside the ledger estimate, and their difference is a **one-off step in own
capital** at the changeover. Above ~96,000 sat that step trips `reserve_drift_long` once
and then ages out of the 48h window by itself.

**The WALLET basis uses `trusted_spendable` (confirmed + own unconfirmed change), not
`total` and not `confirmed`.** Each exclusion pays for itself:

- *Not `total`* — that adds `untrusted_pending`, inbound value that is still reversible
  and that CDK has not credited to a mint quote. Counting it would raise assets with no
  matching liability and read as unexplained drift until it confirmed.
- *Not bare `confirmed`* — an on-chain melt consumes a confirmed UTXO and returns the
  change as `trusted_pending`. Excluding it would drop reserves by the whole input for one
  block rather than by the payout, which for a large UTXO paying a small melt is a
  several-hundred-thousand-sat phantom deficit.

One residual transient remains on the incoming side, and it depends on the mint's
`[bdk] num_confs`. A deposit enters `confirmed` at 1 confirmation but `amount_paid` — and
therefore `Unclaimed` — only rises at `num_confs`. In the gap, reserves are up with
nothing explaining them. It is a positive delta, so it cannot trip the drift rules
directly, but the same observation sitting at a window's *start* shows as a matching
negative. At `num_confs = 1` the gap does not exist; above that it needs a single deposit
over ~96,000 sat to reach a threshold.

**In-flight melts are corrected for on the LEDGER basis only.** A committed on-chain melt
has left the wallet at broadcast, but `completed_operations` gets no row until settlement
— so the estimate subtracts `melt_quote.amount + fee_reserve` for melts still `PENDING`.
Lightning needs no such correction: LND's `local_balance` drops the moment the HTLC is
sent, which is the whole reason the two rails behaved differently. The subtracted quantity
equals `melt_request.inputs_amount`, exactly what `+ Proofs pending` adds back, so own
capital stays flat across the melt. Measured on a real 800,000 sat melt: without it, own
capital spiked +801,828 for 26 minutes and fell back; with it, the step is 63 sat.

The WALLET basis needs none of this — the real wallet already reflects a broadcast spend,
exactly as LND does, so applying the correction there would double-count.

Melts in flight longer than `INFLIGHT_MELT_MAX_AGE_SEC` (24h) are **not** subtracted —
a dropped transaction returns the funds, which would make the correction a permanent
understatement. Those raise `mint_onchain_melt_stuck` instead, because while one is
outstanding the ledger estimate may be overstated by up to that amount.

**The ledger estimate is still collected on the WALLET basis**, into
`Reconciliation.mintOnchainLedger`. Its gap to the measured balance is where every
movement CDK failed to book has to show up, so `mint_wallet_ledger_divergence` watches
that gap *change*. The level itself is meaningless — the ledger accumulator was seeded
from a watermark rather than from the wallet's first transaction, so a large constant
offset is expected.

**If the wallet RPC is configured but does not answer, no reconciliation row is written
for that tick.** The ledger estimate is deliberately *not* substituted: a silent basis
change steps own capital by the divergence between the two and steps back when the
endpoint recovers, manufacturing drift in both directions every time it flaps. A gap is
honest; `mint_wallet_rpc_unreachable` fires CRITICAL because reserve drift is not being
evaluated while it holds.

> **Any change to what `Reserves` includes creates a step that reads as unexplained drift.**
> Either backfill history (`backend/scripts/backfill-onchain.mjs`) or record the change as
> a declared term — never let it land silently in `Remaining delta`.

> **Any change to what `Reserves` includes creates a step that reads as unexplained drift.**
> Either backfill history (`backend/scripts/backfill-onchain.mjs`) or record the change as
> a declared term — never let it land silently in `Remaining delta`.

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

> The **absence** rule is the deadman's switch. A crashed, hung or OOM-killed watchdog emits
> no log line at all — there is no ERROR to match, only silence. The FAIL marker covers what
> the watchdog is still alive enough to report (tick not persisted, all transports down,
> uncaught exception); it cannot cover its own death.

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

Monetary values are msat, serialised as **strings** — msat totals will outgrow a JS double,
and silently losing precision in the reserve figures is the one failure this tool must not
have.

## Editing rule configuration

`RuleConfig` rows are seeded **once** from the code defaults in `backend/src/rules/*.ts`
and never updated afterwards — deliberately, so the seeding logic can never clobber tuning
you have done. The consequence is that **editing a default in source has no effect on an
existing database.**

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

`params` is stored wholesale rather than merged, which is safe because the engine overlays
stored params on the rule's code defaults at evaluation time. So sending only the keys you
want to override works; the rest fall back to the defaults.

**For fresh deployments** — edit the rule module. That changes what new databases seed with,
and nothing else.

**To make changed code defaults apply to an existing database**, reseed the rules while
leaving the measurement history alone:

```bash
yarn reset:data --yes --rules-only
```

It truncates `RuleConfig` and immediately reseeds by calling the engine's own `loadConfigs`,
so what lands in the database is exactly what the app would seed — a reimplementation could
drift from it silently. It prints the resulting table so you can see what took effect.

This **discards any tuning** done through the API, which is the point: it is a deliberate
"go back to the defaults in source" action. To re-seed a single rule instead, delete just
its row and let the next tick recreate it.
