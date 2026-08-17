# AGENTS.md

Rationale behind decisions that look arbitrary or wrong until you know what they prevent.
Read this before changing accounting, thresholds, or the on-chain attribution path.
[SPEC.md](SPEC.md) holds the specification and reconciliation model; [README.md](README.md)
describes what the system does and how to run it.

## Hard boundaries

- **Read-only.** The watchdog never writes to LND or the mint: LND `readonly.macaroon`,
  `SELECT`-only Postgres role. A compromised watchdog must not be able to move funds or
  corrupt mint state.
- **Separate database.** The watchdog's own Postgres is separate from the mint's so
  watchdog load cannot affect the mint, and so the watchdog survives — and can alert on —
  mint database failure.
- **Any change to what `Reserves` includes creates a step that reads as unexplained
  drift.** Either backfill history (`backend/scripts/backfill-onchain.mjs`) or record the
  change as a declared term. Never let it land silently in `Remaining delta`.

## Reconciliation

- **Known income is removed, not tolerated.** Earning routing fees while something drains
  an equal amount would otherwise read as zero drift.
- **`Own capital` is a level and meaningless on its own** — it accumulates routing income,
  fee rounding, channel reserve and initial capitalisation. Only its change carries signal.
- **`+ Proofs pending` is an unverified assumption** whose failure mode is silent: it would
  inflate own capital during every melt, and a positive spike does not trip the drift
  rules. Section G of `scripts/verify-mint-accounting.sql` settles it ([SPEC.md §3.1](SPEC.md)).
- **`PROVABLY_UNSPENDABLE_ECASH` is added to own capital rather than deducted from ecash
  issued**, so the measured liability stays checkable against the mint database. Only for
  provably unspendable ecash — dormant or unclaimed balances do not belong there.
- **Drift rates come from window endpoints, not sums of per-tick deltas**, so a gap in the
  series cannot accumulate error. Hysteresis (clear bar above fire bar) keeps a rate
  hovering at the threshold from producing an endless fire/resolve stream.
  `expectedDriftSatPerHour` exists because the baseline is not zero — the mint is
  legitimately over-capitalised over time by routing income and by rounding Lightning fees
  up to whole sats.
- **Msat as strings on the wire.** Msat totals will outgrow a JS double, and silently
  losing precision in the reserve figures is the one failure this tool must not have.

## On-chain reserves

- **LEDGER basis is a blind spot, not a conservative estimate.** It moves only when CDK
  writes a row, so a manual sweep, an on-chain fee outside a melt, or a bug does not move
  it at all — and undeclared outflow is the single thing this tool exists to catch.
- **WALLET basis uses `trusted_spendable`, not `total` and not `confirmed`:**
  - *Not `total`* — that adds `untrusted_pending`, inbound value still reversible and not
    credited to a mint quote. It would raise assets with no matching liability and read as
    unexplained drift until confirmation.
  - *Not bare `confirmed`* — an on-chain melt consumes a confirmed UTXO and returns change
    as `trusted_pending`. Excluding it drops reserves by the whole input for one block
    instead of by the payout: for a large UTXO paying a small melt, a several-hundred-
    thousand-sat phantom deficit.
- **No silent fallback when the wallet RPC is down.** Substituting the ledger estimate
  would step own capital by the divergence between the two and step back on recovery,
  manufacturing drift in both directions on every flap. A gap in the series is honest;
  `mint_wallet_rpc_unreachable` is CRITICAL because drift is not being evaluated while it
  holds — the watchdog is otherwise alive and reporting healthily while blind on one side.
- **`mint_wallet_ledger_divergence` watches the gap's change, never its level.** The
  ledger accumulator was seeded from a watermark rather than from the wallet's first
  transaction, so a large constant offset is expected. It subtracts both `Deposits
  awaiting credit` and `Dust received`; dust is not a rounding detail there — at 2,503 sat
  it accounted for the entire observed baseline gap on this mint. The wallet legitimately
  leads the books for the whole confirmed→booked lag, and a rule that cannot tell that
  from a discrepancy fires on every ordinary mint. It did, on 2026-08-16, against a
  perfectly valid quote.
- **In-flight melts are corrected for on the LEDGER basis only.** A committed on-chain
  melt has left the wallet at broadcast, but `completed_operations` gets no row until
  settlement, so the estimate subtracts `melt_quote.amount + fee_reserve` for melts still
  `PENDING`. That quantity equals `melt_request.inputs_amount`, exactly what `+ Proofs
  pending` adds back, so own capital stays flat across the melt. Measured on a real
  800,000 sat melt: without it, own capital spiked +801,828 for 26 minutes; with it, the
  step is 63 sat. Lightning needs no such correction — LND's `local_balance` drops the
  moment the HTLC is sent. The WALLET basis needs none either; applying it there would
  double-count.
- **Melts in flight past `INFLIGHT_MELT_MAX_AGE_SEC` (24h) are not subtracted** — a
  dropped transaction returns the funds, which would make the correction a permanent
  understatement. `mint_onchain_melt_stuck` covers the window in which the ledger estimate
  may be overstated by up to that amount.
- **Basis changeover is a one-off step.** `yarn probe:mint-rpc` prints both figures; above
  ~96,000 sat the difference trips `reserve_drift_long` once before ageing out of the 48h
  window.

## On-chain deposit attribution

- **CDK's wallet RPC cannot classify deposits** — `WalletTransaction` has no output
  addresses and `WalletAddress` has no txids, so there is no join
  (until https://github.com/cashubtc/cdk/pull/2367 lands). `BITCOIN_RPC_URL` supplies it:
  `getrawtransaction` output addresses matched against `mint_quote.request` (bare bech32,
  unique-indexed).
- **The confirmed→booked bound must clear the whole distribution, not its median.**
  Measured across 18 real deposits: confirmed→booked min 0.3m / median 22.6m / max 55.1m;
  booked→issued min −21.9m / median 17.1m / max 26.2h. A one-hour bound would have
  released a deposit minutes before CDK booked it; the release and the booking would then
  land in the same window as −X — the exact false CRITICAL the term exists to prevent.
  (The negative booked→issued value is a quote receiving a further payment after an
  earlier issuance, which is why events key on the payment rather than the quote.)
- **Ages are measured from confirmation time, not from first sight.** On the first tick
  after deployment every historical transaction is new *to us*; measured that way, a week
  of long-since-credited deposits booked 2,528,048 sat of fictional liability and would
  have fired an event apiece.
- **Above-minimum deposits are never released on a timer.** Aging one out would be the
  watchdog deciding by timeout that the mint no longer owes it. The moment that
  legitimately becomes true is a keyset phase-out — mint policy under the ToS — declared
  through `PROVABLY_UNSPENDABLE_ECASH`. That set is only bounded because dust is separated
  by amount instead; the deposits that would otherwise accumulate forever are exactly the
  uncreditable ones.
- **Nothing watches the confirmed→booked lag on ordinary deposits.** Quotes never expire,
  and a user who pays on chain and returns the next day to mint is expected behaviour.
  Those are reported only when they clear the large-movement test.

## Dust

- **On-chain mint quotes are unauthenticated.** Anyone can request one and be handed a
  fresh deposit address — no xpub involved — so harvesting the mint's addresses costs an
  attacker nothing but API calls.
- **CDK's minimum is per-receive.** `should_ignore_receive_amount(amount_sat) → amount_sat
  < min_receive_amount_sat` ignores what the quote already holds, so a small top-up to a
  well-funded quote is refused exactly like a first payment. Confirmed against production:
  18 on-chain payments booked, smallest exactly 10,000, none below.
- **Use the mint's `[bdk] min_receive_amount_sat`, not its advertised minimum.** They
  coincide on this mint and need not on another.
- **Dust is booked straight to own capital**, since it can never become ecash and parking
  it in unclaimed would mean waiting for an event that cannot occur. The obvious objection
  — a mis-set threshold excluding a deposit CDK *does* credit, making `unclaimed` jump
  with no offset — is answered by making `dustReceived` a **live set** rather than a
  cumulative one: a credited deposit leaves the set at the same moment it enters
  `unclaimed`, and the two movements cancel in `Remaining delta`. Setting the threshold
  too high costs nothing but a mislabelled dashboard line.
- **`mint_onchain_dust_deposit` fires once on arrival, off the freshness window.** Dust is
  unbooked forever, so a condition-based rule never clears and re-notifies daily, per
  transaction, indefinitely. A 400 sat deposit reporting itself at 98 hours and counting is
  noise.
- **`mint_onchain_dust_cospent` is the moment a dusting attack pays off**: the
  common-input-ownership heuristic attributes every other input address in that
  transaction to the mint, permanently. Preventing it is coin control in CDK — excluding
  sub-minimum UTXOs from input selection — not something the watchdog can do.

## Rules and alerts

- **`state` vs `event` kind.** `state` when the condition is ongoing and its clearing is
  worth a notification; `event` when something merely happened and there is nothing to
  clear — a resolution notice there is pure noise and doubles the message count.
- **`collector_observation_gap` is not a deadman's switch and cannot be one.** It needs a
  later observation to notice the gap, so a watchdog that stopped entirely never fires it.
  The absence rule in the log analyser is the one that matters: a crashed, hung or
  OOM-killed process emits no log line at all, so there is no ERROR to match, only silence.
- **Heartbeat markers are written directly to stdout**, not through the logger, so
  `LOG_LEVEL` cannot suppress them.
- **Rule seeding never updates existing rows**, so seeding can never clobber operator
  tuning. `yarn reset:data --rules-only` reseeds by calling the engine's own
  `loadConfigs` rather than reimplementing it — a reimplementation could drift silently.
- **`mint_unreachable` names the actual failure** (permission, timeout, unreachable)
  rather than reporting all three as one condition.
- **Thresholds are placeholders.** `reserve_drift_*` uses hand-picked numbers, and
  `mint_proofs_pending_high` is deliberately set above the observed baseline so it is
  insensitive rather than noisy. Calibrate against real history before trusting either
  direction.
- **Notifier redaction defaults to `true` per transport.** A public ntfy topic and a
  mailbox on your own domain are different exposures; disclosure should be deliberate, so
  an unset variable errs toward privacy.
- **`ENABLED_SOURCES` makes disabling explicit** so an accidentally missing macaroon fails
  loudly instead of silently leaving the node unmonitored.

## Tooling and layout

- **Not a yarn workspace.** The root `package.json` is a task runner delegating via
  `yarn --cwd`, so each package keeps its own `node_modules` and neither dependency tree is
  hoisted. `package-lock.json` is gitignored so a stray `npm install` cannot quietly
  resolve a different dependency tree.
- **`dev:stop` matches on process identity and working directory, never on port.** On a
  dev machine the production ports are held by the SSH tunnel, so a port-based kill would
  drop the tunnel and make production look down.
- **The frontend `/api/*` proxy is a route handler, not a `rewrites()` entry.**
  `rewrites()` is evaluated at build time and baked into `routes-manifest.json`, so it
  cannot be retargeted by restart; a route handler reads `BACKEND_URL` per request.
- **Mint DB grants live inside the database.** Dropping and recreating it destroys them;
  `ALTER DEFAULT PRIVILEGES` is the line that is easy to skip and expensive to omit,
  because without it a future CDK migration adds a table the watchdog silently cannot read.
  The watchdog does refuse to collect and names the tables — but only after it has already
  stopped working.
