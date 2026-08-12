# Minibits Watchdog — Specification

Internal monitoring tool for the Minibits Lightning node (LND) and ecash mint (**CDK**).
Detects anomalies and growing discrepancies between mint reserves and issued ecash.

> **Mint target is CDK only.** The current Nutshell deployment is being migrated to CDK
> shortly, and the watchdog is built against CDK from the start. No Nutshell support, no
> dual-implementation abstraction.

**Status:** draft spec, pre-scaffolding.

---

## 1. Purpose and scope

Watchdog answers one primary question continuously:

> Is the value backing the mint still consistent with the ecash the mint has issued,
> after accounting for everything legitimately in flight?

Secondary: detect operational failures (node unreachable, force-closes, stuck melts,
mint DB down) and notify a single operator.

### In scope (v1)

- LND read-only telemetry
- CDK mint DB read-only telemetry
- Time-series storage of both
- Periodic rule evaluation with alert lifecycle
- ntfy notifications
- Local dashboard over SSH tunnel

### Explicitly out of scope (v1)

- **Any write or control action.** Watchdog is strictly read-only against LND and the
  mint. No pausing, no draining, no remediation. This is a hard boundary and it is why
  the LND macaroon is `readonly` and the mint DB role has `SELECT` only.
- Multi-operator auth, RBAC, public exposure
- minibits_server (LNURL/NWC) monitoring — **collector interface is designed to accept
  it as a third source, implementation deferred**

---

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Mint DB access | Read-only PG role + polling | Watchdog cannot corrupt the mint. No code in mint's write path. |
| `pg-listen` | **Not used in v1** | Polling-only. NOTIFY gives change signals, not balances; triggers are fragile across Nutshell migrations. |
| Sampling cadence | 5 min, both sources | ~105k rows/yr. Fewer mid-HTLC samples than 1 min. |
| Notifications | ntfy | No app development; iOS+Android; priority levels; self-hostable. |
| LND credential | `readonly.macaroon` | Read-only scope. A compromised watchdog cannot move funds. |
| Watchdog DB | Separate Postgres instance | Must survive, and alert on, mint DB failure. |
| Storage unit | msat, `BigInt` | LND mixes msat/sat; the mint is sat. Normalise once at the edge. |
| Third source | Interface only | minibits_server deferred but not designed out. |
| Mint implementation | **CDK only** | Cutover is imminent; building for Nutshell would be throwaway work. Mint SQL still lives in one module, but there is no adapter interface and no second implementation. |

---

## 3. Reconciliation model

### 3.1 Baseline (from the existing manual sheet)

```
Reserves          = Channel local + On-chain total + Limbo + Cold storage
Own capital       = Reserves − Ecash issued + Proofs pending

Δ own capital     = Own capital[t]   − Own capital[t−1]
Δ unclaimed       = Unclaimed[t]     − Unclaimed[t−1]
Δ cold storage    = Cold storage[t]  − Cold storage[t−1]
Δ mint fees       = Mint fees[t]     − Mint fees[t−1]

Remaining delta   = Δ own capital − Δ unclaimed − Δ cold storage − Δ mint fees
```

**`Own capital` is the mint's equity** — reserves in excess of what it owes. (It is the
column called `Total difference` in the original tracking spreadsheet; renamed here
because "difference" describes the arithmetic rather than the meaning.)

Equivalently, effective liabilities are `Ecash issued − Proofs pending`: proofs locked
in an in-progress melt are treated as already extinguished, keeping the liability side
in step with the asset side during the melt window. Note this **reduces liabilities** — it
does not add to reserves, despite sitting on the same list with a `+` sign.

> ### ⚠ UNVERIFIED: the `+ Proofs pending` term — verify at CDK cutover
>
> This term is correct **only if** CDK's `total_redeemed` counts proofs when they become
> `SPENT`. If it instead increments when they are marked `PENDING`, they have already left
> the liability side and adding them back discounts the same proofs twice.
>
> **The failure mode is silent.** Getting it wrong makes own capital spike *upward* by the
> melt amount for the duration of every melt. A positive spike does not trip the drift
> rules — they fire on negative drift — so nothing would alert, and a spurious +X could
> mask a genuine −X occurring at the same time. Melts are exactly when funds move, so the
> blind spot lands at the worst moment. The transient error scales with melt size.
>
> **Test:** `SELECT sum(amount) FROM proof WHERE state='SPENT'` against
> `keyset_amounts.total_redeemed`. Equal → the term is right. Exceeds by exactly the
> pending total → drop the term. This is section G of
> `scripts/verify-mint-accounting.sql`, so the tier-3 drift check settles it as a
> by-product.
>
> Deferred from the test mint because its melt history is not representative — no melt has
> yet appeared in `completed_operations`. **Run before trusting reserve figures in
> production.**

`Own capital` is a **level** and is not meaningful on its own — it accumulates routing
fee income, the mint rounding Lightning fees up to whole sats, initial channel reserve,
and initial capitalisation. Only its derivative carries signal.

**Every subtracted term is an *explained* change.** `Remaining delta` measures only what
nothing accounts for: unclaimed quotes are explained by mint state, cold storage by
operator declaration, mint fees by the mint's own ledger. Without the cold-storage term,
editing `COLD_STORAGE_RESERVES` would step `Own capital` and read as drift.

### Mint fees are collected by burning ecash

A swap or melt with a non-zero `input_fee_ppk` consumes more input than it issues in
output: `redeemed` rises by the full input, `issued` by the smaller output. Outstanding
ecash therefore *falls* by the fee while reserves are untouched — so **fee income arrives
directly as own capital**, not as a separate asset.

CDK also records the amount, in `keyset_amounts.fee_collected` (and per-operation in
`completed_operations`). That is what makes it subtractable rather than merely tolerable,
and it yields a free consistency check: own-capital growth beyond `Δ fee collected` plus
routing income is unexplained by construction.

**Subtracting it is not bookkeeping neatness — fee income can mask a leak.** Earning
+X per hour while something drains −X leaves `Remaining delta` at zero and the mint
looking healthy. Removing known income exposes the drain.

Currently a no-op: every keyset has `input_fee_ppk = 0`, so `fee_collected` is 0. It is in
the model now so that enabling fees later does not silently shift the drift baseline.

> Lightning **routing** income is a separate, unmeasured contributor and remains inside
> `Remaining delta` — which is why the expected baseline is slightly positive rather than
> zero (§3.4).

### Reserves held outside the node

`COLD_STORAGE_RESERVES` (sat) is an operator-declared figure added to the asset side, so
moving funds to cold storage does not read as a shortfall. It is stored separately from
the LND figures rather than folded into them, keeping what was *measured* distinguishable
from what was *declared*.

Because it is manual, the window between moving coins and updating the value is a real,
undeclared outflow — and the watchdog will alert on it. That is intended: an undeclared
movement of funds off the node is exactly what this tool exists to notice. Update the
value in the same maintenance window as the transfer.

### 3.2 Core principle: alert on differences, not levels

`Remaining delta` is the alertable metric. Because it is a difference, **every constant
offset cancels** — accumulated historical fee income, initial capitalisation, LND anchor
reserve, commitment fee. We therefore do not need a perfect absolute definition of
"backing."

The corollary is the design constraint: **every term that _varies_ must be captured.**
A varying term left out of the model shows up as unexplained `Remaining delta` and
becomes a false positive.

### 3.3 Terms added for continuous sampling

The manual sheet is complete for daily sampling. At 5-minute cadence, three terms that
were previously invisible begin to move:

| Term | Why it matters | Direction |
|---|---|---|
| ~~In-flight HTLCs~~ | **Already covered, and adding them would double-count.** An outgoing melt's HTLC leaves `local_balance`, but CDK marks the proofs `PENDING` at the same moment and `+ Proofs pending` cancels it. Incoming payments are in neither `local_balance` nor the mint's books until they settle, at which point reserves and `unclaimed` rise together. Note also that `unsettled_local_balance` is *incoming* value — an outgoing melt sits in `unsettled_remote_balance` — so it does not even contain the case it would be reached for. Both fields are still captured and shown in the dashboard drill-down, excluded from the arithmetic. | — |
| ~~Pending melt quotes~~ | **Already covered** by the `Proofs pending` term in §3.1 — proofs stay pending for the duration of the melt. Collected anyway, but as a *stuck-melt detector* (§7), not as a reconciliation term. | — |
| Unconfirmed on-chain | Moves in and out of `Wallet balance` on confirmation. | Either |

These do not disappear at 5-minute cadence — a stuck melt is *defined* by outlasting the
sample interval. They simply fire less often than at 1 minute.

### 3.4 Expected baseline is not zero

`Remaining delta` should trend **slightly positive**. Confirmed sources, per live data:

- Lightning routing fee income
- The mint rounding Lightning fees up to whole sats
- Melt fee-reserve overpayment refunds

**Mint input fees are excluded from this baseline — but not because they do not exist.**
They are subtracted explicitly as `Δ mint fees` (see above), so they never reach
`Remaining delta`. Today they are additionally zero, since every keyset has
`input_fee_ppk = 0`. Enabling fees will therefore *not* shift the drift baseline, which is
the point of subtracting them rather than absorbing them into the expected band.

Alerting against zero will still drift into a permanent false positive as volume grows.

The expected drift rate is to be estimated empirically from the historical sheet
(see §11, open item 2), then carried as a configurable `expectedDriftMsatPerHour`.
Alerts compare against that baseline, not against zero.

### 3.5 Design principle: store raw, derive late

LND's exact balance semantics (which of `local_balance`,
`unsettled_local_balance`, `unsettled_remote_balance`, `pending_open_local_balance`
belong on the assets side) are easy to get subtly wrong, and a wrong formula silently
corrupts every historical row.

**Therefore: persist the complete `ChannelBalanceResponse` and `WalletBalanceResponse`
field sets verbatim, and compute derived metrics in the query layer.** A formula error
is then repairable retroactively over existing history, rather than requiring
re-collection that is impossible after the fact.

Same rule for the mint side: store issued / redeemed / pending / unclaimed as raw
aggregates; derive all differences downstream.

---

## 4. Data sources

### 4.1 LND

Via `@lightningpolar/lnd-api`, same client pattern as
`minibits_server/src/services/lndService.ts`, with `LND_READONLY_MACAROON`.

Per tick:

| Call | Captured |
|---|---|
| `channelBalance` | All balance fields verbatim |
| `walletBalance` | confirmed, unconfirmed, locked, reserved |
| `pendingChannels` | `total_limbo_balance`, per-channel pending states |
| `listChannels` | count, active/inactive, per-peer local/remote (for health rules) |
| `getInfo` | block height, synced_to_chain, synced_to_graph, version |

### 4.2 Mint (CDK Postgres)

Read-only role, `SELECT` only, `default_transaction_read_only=on`, `statement_timeout`.

All mint SQL lives in a single module (`src/sources/mint/`). Not because a second
implementation is expected, but so that CDK schema changes across releases have one
blast radius.

Schema confirmed by introspection (CDK on PostgreSQL 12). Relevant tables:

| Table | Scale | Role |
|---|---|---|
| `keyset_amounts` | one row per keyset | **Running per-keyset `total_issued` / `total_redeemed` / `fee_collected`** |
| `keyset` | one row per keyset | `unit`, `active`, `input_fee_ppk` |
| `proof` | largest table | `amount`, `keyset_id`, `state`, `created_time` |
| `blind_signature` | very large | `amount`, `keyset_id`, `c` (null until signed), `signed_time` |
| `mint_quote` | large, wide rows | `amount_paid`, `amount_issued`, `unit`, `created_time` |
| `melt_quote` | large | `amount`, `fee_reserve`, `state`, `created_time`, `paid_time` |
| `mint_quote_issued` | large, narrow | Append-only ledger: monotonic `id`, `timestamp`, `amount` |
| `mint_quote_payments` | large, narrow | Append-only ledger: monotonic `id`, `timestamp`, `amount` |
| `saga_state` | transient | In-flight operation state machine |

Sizes are deliberately qualitative — run `scripts/introspect-mint-db.sql` for the actual
figures on your deployment, since they drive the cost decisions below.

No views, no triggers, no enum types — states are `text`.

### Per-tick queries (cheap)

| Metric | Source |
|---|---|
| `issued`, `redeemed`, `feeCollected` | `keyset_amounts` joined to `keyset` for unit — **2-row read** |
| `outstanding` | `issued − redeemed` — the sheet's `Mint balance` |
| `proofsPending` | `SUM(amount) FROM proof WHERE state='PENDING'` — index `idx_proof_state_operation` |
| `unclaimedMintQuotes` | `SUM(amount_paid − amount_issued) FROM mint_quote WHERE amount_paid > amount_issued` |
| `pendingMeltQuotes` | `melt_quote WHERE state='PENDING'` — index `melt_quote_state_index`, a small subset. **`PAID` is a terminal success state in CDK, not in-flight**: it is the majority of the table, so including it turns an index scan into a full sequential scan. Recorded as a metric; stuck detection anchors on pending proofs instead (§7) |
| `sagasInFlight` | `saga_state` grouped by `operation_kind`, `state` |

All per `unit`, since reconciliation is per-unit.

**No watermark aggregation needed.** `keyset_amounts` already maintains the running totals,
so the O(table) scan the watermark scheme existed to avoid does not arise. This removes the
correctness risk that came with it (a missed row biasing every subsequent balance forever).

`mint_quote` tracks amounts rather than a state enum, so partial issuance is expressible
and `unclaimedMintQuotes` handles it naturally.

### Ledger drift check (infrequent, expensive)

Using `keyset_amounts` means inheriting any bug in how CDK maintains it. A running total
that has silently diverged from the underlying rows is precisely the failure class this
tool exists to catch, so it must be verified rather than trusted:

```
issued   ?= SUM(blind_signature.amount)   -- signed rows only; c IS NULL means reserved-not-signed
redeemed ?= SUM(proof.amount WHERE state='SPENT')
```

Full scans of the two largest tables. **The mint database shares the production cluster**, so these
compete with production for I/O and shared buffers — the cost is real even off the
critical path. Consequently:

- **Not nightly.** Weekly, at a low-traffic hour, is enough to catch a ledger bug long
  before it matters, and a drift that only appears between weekly runs is still caught.
- Prefer a replica or a restored backup if one becomes available — the check needs
  consistency, not freshness.
- An incremental version (comparing per-interval deltas rather than absolute sums) would
  be cheap, but neither `blind_signature.created_time` nor `proof.created_time` is
  indexed, so it would require adding an index to the mint — a write to the mint
  database, which §1 rules out. Revisit only if CDK adds one upstream.

Non-zero drift is a critical alert.

Whether `issued` matches all `blind_signature` rows or only signed ones determines when CDK
counts issuance — established once by `scripts/verify-mint-accounting.sql`.

### Query cost tiers

| Tier | Queries | Cost | Script |
|---|---|---|---|
| 1 — per tick | `keyset_amounts`, `proof` state=PENDING, `melt_quote` in-flight, `saga_state`, `melt_request` | Index-assisted or tiny tables; negligible | `verify-mint-light.sql` |
| 2 — unclaimed | `mint_quote` where `amount_paid > amount_issued` | Full scan of a large, wide table — no index supports the predicate. Cheaper cross-check available via the two narrow ledger tables | — |
| 3 — drift | `blind_signature`, `proof` state=SPENT | Full scan of both largest tables | `verify-mint-accounting.sql` |

`scripts/explain-mint-queries.sql` runs `EXPLAIN` without `ANALYZE` on all of the above —
planner estimates only, nothing executed, zero I/O — to confirm the tier 1 queries really
do use indexes before any of this reaches production.

**Velocity queries.** Polling cannot see events that start and finish inside one 5-minute
window, so velocity rules query `mint_quote_issued` / `mint_quote_payments` by their
monotonic `id` (PK-indexed) rather than by `timestamp`, which is unindexed on both tables.

### `Total unclaimed` via ledger watermark

`mint_quote` has no index supporting `amount_paid > amount_issued`, and its rows average
~1.3 kB, so even a 7-day window still costs a 19.8k bitmap heap scan against 33.9k for the
full table — windowing is the wrong lever. Instead:

```
Total unclaimed = SUM(mint_quote_payments.amount) − SUM(mint_quote_issued.amount)
```

Quotes where paid equals issued contribute zero, so this equals the sheet's figure provided
nothing has issued more than it was paid — itself an integrity invariant, and captured as
`overIssuedMintQuotes` when the difference goes negative.

Both tables are narrow, append-only, and keyed by a monotonic integer PK, so a persisted
watermark (`LedgerWatermark`) reduces per-tick cost to O(new rows) after one initial pass.
The frozen boundary lags `max(id)` by an overlap window because a sequence assigns ids
before commit — a lower id can commit after a higher one, and freezing right up to
`max(id)` would skip it permanently.

**Two assumptions this rests on, neither yet verified:**

1. **The ledgers are never pruned.** If CDK deletes rows, the frozen total silently
   overstates. The weekly job must therefore recompute the frozen total from scratch, not
   only run the drift check.
2. **The ledger difference equals the `mint_quote` figure.** Confirmed only for windowed
   subsets so far. Needs one comparison against
   `SUM(amount_paid − amount_issued) FROM mint_quote` during a quiet window.

### 4.3 minibits_server (deferred)

Collector interface accepts N sources. Third implementation deferred; would cover stuck
LNURL invoices and NWC failures.

---

## 5. Data model (Prisma / Postgres)

```prisma
// One coherent observation across all sources.
model Observation {
  id            Int       @id @default(autoincrement())
  observedAt    DateTime                 // logical sample time
  skewMs        Int                      // max gap between source reads
  lndStatus     SourceStatus
  mintStatus    SourceStatus
  lnd           LndSnapshot?
  mint          MintSnapshot?
  reconciliation Reconciliation?
  @@index([observedAt])
}

enum SourceStatus { OK, UNREACHABLE, ERROR, TIMEOUT }
```

`LndSnapshot` and `MintSnapshot` hold the raw fields from §4 as `BigInt` msat.
`Reconciliation` holds derived values (`totalNodeBalance`, `totalDifference`,
`remainingDelta`, windowed rates).

Plus `Alert` (lifecycle, §7), `RuleConfig` (thresholds, seeded from code defaults),
and `Event` (discrete observations: force-close detected, new keyset seen).

### Sampling coherence

**One `Observation` = one coherent moment.** All sources are read as close together as
possible and share a single `observedAt`, with actual `skewMs` recorded. Reconciliation
across sources read minutes apart is meaningless.

### Partial failure

If LND is up and the mint DB is down, **write the row** with the mint snapshot null and
`mintStatus=UNREACHABLE`. Do not skip it. A gap must be distinguishable from "nothing
happened," and reconciliation must refuse to compute rather than emit garbage.

### Retention

None in v1. At 5-minute cadence this is ~105k rows/year. Revisit when there is a reason.

### Rate semantics

The sheet's `Delta difference` is "since the last row" and therefore cadence-dependent.
Automated, deltas are **rates over fixed windows** (1h, 24h) so the number means the same
thing regardless of sampling interval or a missed sample.

### BigInt gotcha

Prisma `BigInt` does not survive `JSON.stringify`. A serializer is required at the
Fastify boundary.

---

## 6. Collector

- Single scheduled tick, 5 min, all sources read concurrently.
- Per-source timeout, independently recorded. One slow source must not delay the tick.
- Source interface is generic (`collect(): Promise<SourceResult>`) so minibits_server
  drops in later without restructuring.
- Cold start: mint history **is reconstructible**. `mint_quote_issued` and
  `mint_quote_payments` are append-only with timestamps, and `blind_signature.created_time`
  / `proof.created_time` give the issuance and redemption curves. One grouped query per
  table backfills the mint side of the trend. LND channel balances are **not**
  reconstructible; only flows, via `listinvoices` / `listpayments`.

---

## 7. Rules and alert lifecycle

### Rule implementation

TS modules implementing a common interface, registered in an array. Typed and unit
testable — no DSL. Thresholds live in `RuleConfig` rows seeded from code defaults, so
tuning does not require a redeploy.

### Alert lifecycle — required from day one

This is where monitoring tools fail. Without it, transient in-flight deltas page at 3am
and notifications get muted within a week.

- `firing` / `resolved` states with dedupe
- **Hysteresis** — separate fire and clear thresholds
- **`for` duration** — condition must hold N consecutive evaluations before firing
- Re-notify cooldown
- Severity tiers

### State rules vs event rules

Not every rule describes an ongoing condition, and treating them alike doubles the
notification cost of the ones that do not.

- **State** (`lnd_unreachable`, `reserve_drift_*`, `mint_over_issued`): describes something
  that *is true now*. Recovery is worth knowing, so clearing notifies.
- **Event** (`collector_observation_gap`, `mint_keyset_change`): describes something that
  *happened*. There is no condition to clear, so a resolution notice is pure noise — the
  operator already knows the gap occurred, and "the gap has stopped happening" is not
  information.

Event rules set `notifyOnResolve: false`. They still auto-resolve so the active alert list
stays clean; only the notification is suppressed. Verified in one run: the gap rule fired
with a single send and resolved silently, while `reserve_drift_short` resolved with a send,
as intended.

> **Deployment note.** `loadConfigs` only *creates* missing `RuleConfig` rows — it never
> updates existing ones, so operator tuning is never clobbered. The consequence is that
> changing a code default has no effect on an already-seeded deployment: the row must be
> `PATCH`ed via `/api/rules/:ruleId` or deleted so it re-seeds.

### Rule catalogue (v1)

| Tier | Rule |
|---|---|
| Solvency | `Remaining delta` below expected drift baseline, sustained |
| Solvency | Downward trend beyond noise band over multi-hour window |
| **Integrity** | **`keyset_amounts` diverges from raw `blind_signature` / `proof` sums** (weekly, §4.2) |
| **Integrity** | **Mint table unreadable or newly appeared.** Enumerate every table in the mint's schema and check `has_table_privilege(...,'SELECT')`. A CDK migration adding a table the watchdog cannot read is a silent blind spot — worse if that migration relocates accounting, since the collector would keep reporting stale figures from the old tables while looking healthy. Also fires on an unrecognised table, which flags a schema change worth reading before trusting the numbers. |
| Integrity | `mint_quote.amount_issued > amount_paid` — ecash issued against an unpaid quote |
| Stuck | `saga_state` / `melt_request` row older than threshold. Neither table is reliably cleaned up — `melt_request` currently holds rows for quotes that reached `PAID` two months ago — so age alone is the signal. |
| Stuck | **Proofs held in `PENDING` beyond threshold.** Anchor the stuck-melt rule here, **not** on `melt_quote.state='PENDING'`: that state accumulates permanent residue — stale rows spanning many months, far outnumbering the proofs actually locked — so a naive rule fires a large batch of alerts on historical junk at first run. Pending proofs are also the quantity that actually affects the §3.1 identity. |
| Stuck | Mint quote paid but not issued beyond threshold |
| LND | Node unreachable / not synced to chain |
| LND | Force-close detected; limbo balance non-zero |
| LND | Channel inactive while holding significant local balance |
| Mint | DB unreachable; `/v1/info` unresponsive |
| Mint | Unexpected new or deactivated keyset |
| Velocity | Volume spike, large single melt, failed-melt spike |

---

## 8. Notifications

Transports behind a `Notifier` interface, selected via `ENABLED_NOTIFIERS`. Implemented:
**ntfy** and **email (SMTP)**. A Nostr DM transport would slot in the same way and is the
only option offering end-to-end encryption without self-hosting.

**Fan-out.** With more than one transport enabled, `MultiNotifier` sends to all of them
concurrently. A send succeeds if *any* transport succeeds — escalating to the deadman's
switch because a secondary channel is down would cry wolf while the operator is in fact
being reached. It fails only when every transport fails. A *partial* failure is still
recorded as an `Event`, because otherwise a broken secondary stays broken indefinitely
behind a working primary, and is discovered only when the primary also fails.

**Email caveat.** SMTP returning `250 Accepted` does not mean the message was read — it can
still be filed as spam. That is a silent failure the deadman's switch cannot detect, since
delivery genuinely succeeded. Email is therefore a secondary channel beside push, not a
replacement for it.

Two constraints that hold regardless of channel:

1. **Delivery must not depend on what is monitored.** Mint DB down still has to reach
   the operator.
2. **Deadman's switch.** An outbound heartbeat per tick to an external service, so a
   silently dead watchdog does not read as "all clear." Silence is the most dangerous
   failure mode a monitoring tool has.

### Implemented behaviour

- **Heartbeat semantics.** The ping asserts "the watchdog is alive and completing ticks",
  not "everything is healthy" — a failed source has its own rule, and conflating the two
  would make the deadman's switch fire for conditions it cannot distinguish. Emitted on
  tick completion regardless of source status; the failure variant on a tick that cannot be
  persisted, on total notification failure, and on an uncaught exception.
- **Two delivery channels: log markers (always) and an optional HTTP ping.** Markers are
  single-line JSON written directly to stdout, deliberately bypassing `logService` so that
  raising `LOG_LEVEL` cannot silently switch off the liveness signal. Verified: at
  `LOG_LEVEL=error`, with every INFO line suppressed, the marker is still emitted.

  ```
  {"marker":"WATCHDOG_HEARTBEAT_OK","ts":"…","observationId":20,"lnd":"OK","mint":"OK","durationMs":955}
  {"marker":"WATCHDOG_HEARTBEAT_FAIL","ts":"…","detail":"test notification failed on: ntfy"}
  ```

- **The absence rule is the deadman's switch; the FAIL marker is not.** A crashed, hung or
  OOM-killed process emits nothing — there is no ERROR to match, only silence. An external
  log analyser must therefore alert on *no `WATCHDOG_HEARTBEAT_OK` within 3× the collect
  interval*, in addition to alerting on any `WATCHDOG_HEARTBEAT_FAIL`. Matching only the
  FAIL marker catches the failures the watchdog can still report and misses precisely the
  one it cannot: its own death.
- **Notification failure escalates to the heartbeat.** A watchdog that runs but cannot
  deliver is, to the operator, no better than one that has stopped — and the heartbeat is
  the only channel that does not depend on the notifier working.
- **Unconfigured means refused, not silently inert.** `POST /api/notify/test` returns 409
  rather than reporting success when no external transport is set, and the startup banner
  warns. An alerting path that has never been exercised is an assumption, not a safeguard.
- **Header sanitisation.** ntfy carries title, priority and tags as HTTP headers, which
  must be single-line ASCII; alert titles contain formatted amounts and free text, so
  non-conforming characters are transliterated rather than risking a rejected request.

### Privacy

Alert payloads carry reserve amounts, pending proof totals, channel balances and
force-close events. Two exposures, neither solved by choosing email over push:

- Public ntfy.sh topics are unauthenticated — anyone who knows or guesses the name reads
  every alert, with no way to revoke history.
- SMTP is encrypted hop-by-hop, **not** end to end. The destination mailbox provider sees
  plaintext.

**`NOTIFY_REDACT_AMOUNTS`** addresses both without self-hosting: numeric amounts are
replaced with `***` before sending, applied once in the engine so no transport added later
can bypass it. Severity, rule id, subject and small counts survive, so alerts keep their
urgency and still say what to look at — the figures are then read from the dashboard over
the SSH tunnel. Redacted example:

```
Reserve drift -*** sat/h over 6h (sat)
*** sat of proofs pending (12 proofs, sat)
Mint database unreachable (UNREACHABLE)
```

Self-hosting ntfy remains the stronger answer where infrastructure allows, since it removes
the third party entirely rather than limiting what is disclosed to it.

---

## 9. Frontend

Next 14 + Tailwind, following `minibits_recovery/frontend`. Two-process split (Fastify
API + Next) to reuse that template directly.

- Latest values + time-trend charts for the §3 metrics
- Active and recent alerts
- Reconciliation breakdown showing each term's contribution to `Remaining delta` —
  this is the view that makes an alert diagnosable rather than just alarming
- Polling refresh, no live socket needed at 5-minute cadence

**Security:** bind API and frontend to `127.0.0.1` only. Both `minibits_ippon` and
`minibits_server` bind `0.0.0.0`; copying that into a no-auth dashboard would expose it
beyond the SSH tunnel.

---

## 10. Configuration

```
DATABASE_URL                  # watchdog's own Postgres
MINT_DATABASE_URL             # read-only role
LND_HOST / LND_PORT
LND_READONLY_MACAROON
LND_TLS_CERT
COLLECT_INTERVAL_MS=300000
NTFY_URL / NTFY_TOPIC / NTFY_TOKEN
HEARTBEAT_URL
LOG_LEVEL
PORT                          # bound to 127.0.0.1
```

Fail fast on missing required vars at startup, with a masked startup config banner —
same pattern as `minibits_ippon/src/index.ts`.

---

## 11. Open items

1. ~~`Proofs pending` sign convention~~ — **resolved.** Added back to reserves; see §3.1.
2. **Historical CSV export.** Needed to backfill the dashboard and to calibrate the noise
   band and `expectedDriftMsatPerHour` empirically rather than guessing thresholds.
   Weight increases if CDK does not carry pre-cutover history (§6).
3. ~~CDK schema introspection~~ — **resolved**, §4.2 reflects the real schema.
4. **Accounting verification** — run `scripts/verify-mint-accounting.sql` and compare
   section F against the latest sheet row. Confirms our reading of the schema before any
   code depends on it. Section G must be zero.
5. **Watchdog timing relative to cutover** — live before, during, or after? The migration
   is the moment reserve monitoring is most valuable, but only if it is already trusted
   and calibrated by then.
6. **Deadman's switch target** — healthchecks.io, self-hosted Healthchecks, or ntfy-based.
7. **PostgreSQL 12 is end-of-life** (Nov 2024), as is Ubuntu 20.04. Not the watchdog's
   problem, but the CDK migration is a natural moment to move both. Nothing in this spec
   requires a newer version.

---

## 12. Build order

The watchdog is **not** required to be live for the CDK cutover — integrity checking during
the migration is handled separately in that process. That removes the deadline and allows
the natural dependency order rather than a reconciliation-first rush.

1. **Scaffold** — backend (Fastify + Prisma + esbuild/ESM, per `minibits_ippon`), frontend
   (Next 14 + Tailwind, per `minibits_recovery/frontend`), config and startup validation.
2. **Storage** — Prisma schema for `Observation` / `LndSnapshot` / `MintSnapshot` /
   `Reconciliation` / `Alert` / `RuleConfig` / `Event`, with the `BigInt` serializer.
3. **LND collector** — fully specified and independent of the mint work.
4. **Mint collector** — the §4.2 queries, once `verify-mint-accounting.sql` confirms them
   against the sheet.
5. **Reconciliation** — §3 identity over stored observations.
6. **Rule engine + alert lifecycle** — hysteresis, `for` duration, cooldown (§7).
7. **ntfy notifier + deadman's switch** (§8).
8. **Dashboard** (§9).
9. **Backfill + calibration** — mint history from the append-only ledgers, noise band and
   `expectedDriftMsatPerHour` from the sheet CSV.

Steps 1–7 are complete (13 rules registered). Step 8 (dashboard) is next.

**Verified in step 6:** duration gating (`lnd_inactive_channels` fired only on the 3rd
consecutive evaluation), resolution (`collector_observation_gap` cleared after 1 miss), and
cooldown suppression (6 consecutive hits produced `notifyCount = 1`, not 6). Alert states
carry a third status, `PENDING`, for a condition seen but not yet held long enough to fire —
without it a never-fired alert would be recorded as `RESOLVED`, which reads as "fired and
recovered".
