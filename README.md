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
Remaining delta = Δ Own capital − Δ Unclaimed − Δ Deposits awaiting credit
                  − Δ Dust received − Δ Cold storage − Δ Unspendable ecash
                  − Δ Mint fees
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
| 6. Rule engine + alert lifecycle | done — [22 rules](#rules) |
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

### Deposit recognition: why `Deposits awaiting credit` exists

A deposit becomes an **asset** when BDK confirms it, but the matching **liability** — the
ecash the mint now owes — only appears when CDK writes `amount_paid`. Measured on
2026-08-16, that lag was 15 minutes:

| UTC | Event |
|---|---|
| 12:02:44 | on-chain mint quote created, 420,000 sat |
| 12:07:59 | deposit confirms in BDK — asset recognised |
| 12:23:00 | CDK books the payment — liability recognised |
| 12:40:07 | ecash issued |

Any 6h window *starting* inside those 15 minutes holds the deposit in reserves at its
start and then watches ecash be created against it: assets flat, liabilities +420,000.
That fired a CRITICAL at 18:09:52 and cleared at 18:29:52 — the gap plus six hours, to the
second. With deposits over the threshold arriving roughly daily, it would have recurred
roughly daily.

`Deposits awaiting credit` counts a confirmed deposit as unclaimed from the moment it
confirms, which closes the identity at every step:

```
deposit confirms   reserves +X, awaiting +X                → remaining 0
CDK books it       awaiting −X, unclaimed +X               → remaining 0
ecash issued       unclaimed −X, ecash issued +X, cap −X   → remaining 0
```

A genuine unbooked outflow still reads as −X, because nothing on the liability side moves
with it. That is the point of the wallet basis and it is preserved.

### Deposit attribution: the three categories

Value entering the wallet is one of three things, with completely different accounting:

| | Origin | Liability | Treatment |
|---|---|---|---|
| **A** | User paying an on-chain mint quote | ecash owed | counts to unclaimed until issued |
| **B** | Operator, from outside the monitored perimeter | none | raises own capital |
| **C** | Operator, from the monitored LND on-chain wallet | none | nets to zero across the two pools, less fee |

CDK's wallet RPC cannot tell them apart — `WalletTransaction` has no output addresses and
`WalletAddress` has no txids, so there is no join. `BITCOIN_RPC_URL` supplies it: one
`getrawtransaction` gives the output addresses, which are matched against
`mint_quote.request` (bare bech32, unique-indexed). A match is **A**; no match is **B/C**,
which never touches unclaimed.

Two details that are easy to get wrong:

- **Key on the payment, not the quote.** A quote can receive further payments after it has
  already been paid and issued against. A quote-keyed event would swallow every payment
  after the first as a duplicate.
- **`payment_id` is `txid:vout`.** Because the chain lookup tells us *which* output paid
  the quote address, the credited check is an equality lookup on that unique index rather
  than a prefix range whose correctness would depend on how the database's collation
  orders `:` against digits.

Without a chain source the collector falls back to inference: a deposit is assumed to be
**A** for 24 hours, then released to own capital. Conservative — it counts value as owed
rather than as equity, so it cannot manufacture a shortfall — and the release is a
*positive* step, which no drift rule can fire on.

### An on-chain mint taking hours is normal

Measured across 18 real deposits:

| | min | median | max |
|---|---|---|---|
| **confirmed → booked** (`amount_paid`) | 0.3m | 22.6m | **55.1m** |
| **booked → issued** (`amount_issued`) | −21.9m | 17.1m | **26.2h** |

The second lag is the user: they pay on chain, know the mint wants confirmations, and come
back when it suits them. It is `Unclaimed`, balanced at both ends, and nothing warns on it.
*(The negative value is a quote receiving a further payment after an earlier issuance —
which is why events key on the payment rather than the quote.)*

The first lag is chain-driven and bounded, but its real maximum is what sets the inference
bound. A one-hour bound would have released a deposit minutes before CDK booked it, and the
release plus the booking would then have landed in the same window as −X — the exact false
CRITICAL the term exists to prevent. Bounds go clear of the distribution, not past its
median.

### Dust deposits and address clustering

On-chain mint quotes are **unauthenticated**. Anyone can request one and be handed a fresh
deposit address — no xpub involved — so harvesting the mint's addresses costs an attacker
nothing but API calls.

A deposit below `[bdk] min_receive_amount_sat` is never credited. CDK's check is
`should_ignore_receive_amount(amount_sat) → amount_sat < min_receive_amount_sat`: it tests
each receive on its own and **ignores what the quote already holds**, so a small top-up to
a well-funded quote is refused exactly like a first payment. Confirmed against production —
18 on-chain payments booked, smallest exactly 10,000, none below.

Such dust is harmless while it sits. It stops being harmless when the wallet **co-spends**
it: the common-input-ownership heuristic then attributes every other input address in that
transaction to the mint, and the sender gets a map of the wallet for a few hundred sats.
`mint_onchain_dust_cospent` reports that moment, reading each outgoing transaction's inputs
from the chain source. Preventing it is coin control in CDK — excluding sub-minimum UTXOs
from input selection — not something the watchdog can do.

Dust is therefore **booked straight to own capital**, via
`MINT_ONCHAIN_MIN_RECEIVE_SAT`. It can never become ecash, so the mint owes nobody for it,
and parking it in unclaimed would mean waiting for an event that cannot occur.

> The obvious objection is that a mis-set threshold would exclude a deposit CDK *does*
> credit, so `unclaimed` would jump with no offset and a false CRITICAL would follow. That
> is answered by making `dustReceived` a **live set** rather than a cumulative one: if CDK
> credits a deposit classified as dust, it leaves the set at the same moment it enters
> `unclaimed`, and the two movements cancel in `remaining delta`. Setting the threshold too
> high costs nothing but a mislabelled line on the dashboard.
>
> Use the mint's `[bdk] min_receive_amount_sat`, not its advertised minimum — they coincide
> on this mint and need not on another.

Each dust deposit raises `mint_onchain_dust_deposit` **once, on arrival**. It is an event,
fired off the freshness window rather than off a standing condition — because a dust
deposit is unbooked *forever*, so a condition-based rule never clears and re-notifies
daily, per transaction, indefinitely. A 400 sat deposit reporting itself at 98 hours and
counting is noise; one notification per arrival is what makes the frequency legible.

Nothing watches the confirmed→booked lag on ordinary deposits. Above the minimum, a deposit
taking hours is normal operation: quotes never expire, and a user who pays on chain and
returns the next day to mint is expected behaviour. Those are reported only when they clear
the large-movement test.

**Above-minimum deposits are never released on a timer.** Aging one out would be the
watchdog deciding by timeout that the mint no longer owes it. The moment that legitimately
becomes true is a keyset phase-out — mint policy under the ToS — declared through
`PROVABLY_UNSPENDABLE_ECASH`. That is only bounded because dust is separated by amount
instead; the deposits that would otherwise accumulate forever are exactly the uncreditable
ones.

`mint_wallet_ledger_divergence` subtracts **both** `Deposits awaiting credit` and
`Dust received`. Dust is not a rounding detail there: at 2,503 sat it accounted for the
*entire* observed baseline gap between the wallet and the ledger on this mint — the wallet
holds sub-minimum deposits CDK never booked, so the ledger cannot see them. With both
explained components removed the gap starts at zero, which is what makes its movement
meaningful rather than noise around an arbitrary historical offset.
The wallet legitimately leads the books for the whole of lag 1, and a rule that cannot tell
that from a discrepancy fires on every ordinary mint — it did, on 2026-08-16, against a
perfectly valid quote.

Ages are measured from **confirmation time**, not from when the watchdog first saw the
transaction. On the first tick after deployment every historical transaction is new *to
us*; measured that way, a week of long-since-credited deposits booked 2,528,048 sat of
fictional liability and would have fired an event apiece.

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

## Rules

22 rules, all tunable at runtime without a redeploy — see [Editing rule
configuration](#editing-rule-configuration). Logic lives in
`backend/src/rules/`; only the thresholds live in the database.

**`for`** is how many consecutive evaluations the condition must hold before firing (one
evaluation per collection tick, 5 minutes by default). **Kind** is `state` when the
condition is ongoing and its clearing is worth a notification, or `event` when something
merely happened and there is nothing to clear — a resolution notice there is pure noise and
doubles the message count.

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
| `mint_unreachable` | CRITICAL | 2 | state | The mint database read failed. Names the actual failure — permission, timeout, unreachable — rather than reporting all three as one |
| `mint_over_issued` | CRITICAL | 1 | state | `amount_issued > amount_paid`: ecash created against an unpaid quote. A hard invariant; must always be zero |
| `mint_schema_access` | WARNING | 1 | state | A required table is unreadable, or an unrecognised one appeared — a CDK migration may have relocated accounting |
| `mint_keyset_change` | INFO | 1 | event | Keyset count changed. Verify it was an intentional rotation |
| `mint_proofs_pending_high` | WARNING | 3 | state | Proofs locked in `PENDING` above `thresholdSat` (500,000). **Uncalibrated** — deliberately above baseline, so currently insensitive rather than noisy |
| `mint_melt_requests_stuck` | WARNING | 3 | state | More than `maxRows` (25) rows in the transient `melt_request` table |
| `mint_onchain_melt_stuck` | WARNING | 2 | state | A committed on-chain melt is unsettled past 24h, so it is no longer subtracted. Degrades the ledger **cross-check**, not reserves — the measured wallet already reflects the spend |

### Mint — BDK wallet

Only evaluated when `MINT_RPC_HOST` is set; they return "not evaluable" otherwise rather
than a false all-clear.

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `mint_wallet_rpc_unreachable` | CRITICAL | 3 | state | The wallet balance could not be read. CRITICAL because no reconciliation row is written while it holds, so **reserve drift is not being evaluated** — the watchdog is alive and reporting healthily while blind on one side |
| `mint_wallet_ledger_divergence` | WARNING | 3 | state | The wallet-versus-ledger gap **moved** more than `thresholdSat` (50,000) over `windowHours` (24). The level is never the signal; deposits awaiting credit and dust are both subtracted, so the gap starts at zero |
| `mint_wallet_sync` | WARNING / CRITICAL | 3 | state | The wallet is more than `maxBlocksBehind` (6) behind LND's height, or on a network other than `expectedNetwork` (CRITICAL). A stalled BDK sync reports a stale balance with complete confidence; LND's height is an independent read of the same chain |

### Mint — on-chain movements

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `mint_onchain_large_mint` | INFO | 1 | event | A deposit against a mint quote exceeds `fractionPct` (20) of the **pre-movement** wallet balance. Keyed on the payment, not the quote — a quote can receive further payments after it has been paid and issued against |
| `mint_onchain_large_melt` | INFO | 1 | event | A net outflow exceeds `fractionPct` (20) of the pre-movement balance. Keyed on the transaction, which is the right granularity since CDK batches several melt quotes into one |
| `mint_onchain_deposit_unattributed` | WARNING | 1 | event | A confirmed deposit paid no mint quote address. Operator liquidity, or something unexpected — either way the mint owes no ecash, so it is excluded from unclaimed |
| `mint_onchain_dust_deposit` | WARNING | 1 | event | A confirmed deposit below `MINT_ONCHAIN_MIN_RECEIVE_SAT`, which CDK can never credit. Fires **once on arrival**, not on a standing condition — dust is unbooked forever, so a condition-based rule would never clear |
| `mint_onchain_dust_cospent` | WARNING | 1 | event | The wallet spent a deposit it never credited. This is a dusting attack **paying off**: common-input-ownership now links every co-input address to the mint, permanently. Needs `BITCOIN_RPC_URL` for transaction inputs |

### Reconciliation

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `reserve_drift_short` | CRITICAL | 2 | state | `Remaining delta` falls below −20,000 sat/h over 6h |
| `reserve_drift_long` | WARNING | 3 | state | `Remaining delta` falls below −2,000 sat/h over 48h |

Both are rates from the window **endpoints**, not sums of per-tick deltas, so a gap in the
series cannot accumulate error. Value hysteresis: the bar to clear is higher than the bar to
fire, so a rate hovering at the threshold does not produce an endless fire/resolve stream.
`expectedDriftSatPerHour` exists because the baseline is **not zero** — the mint is
legitimately over-capitalised over time by routing income and by rounding Lightning fees up
to whole sats.

### Collector

| Rule | Severity | for | Kind | Fires when |
|---|---|---|---|---|
| `collector_observation_gap` | WARNING | 1 | event | The interval between observations exceeded `toleranceMultiple` (3) × the collection interval |

> This rule is **not** a deadman's switch and cannot be one: it needs a later observation to
> notice the gap, so a watchdog that stopped entirely never fires it. See
> [Deadman's switch](#deadmans-switch-via-log-analysis) — the absence rule is the one that
> matters.

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
