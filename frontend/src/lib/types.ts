/**
 * Monetary values arrive as decimal strings, not numbers: they are msat BigInt
 * server-side, and msat totals will outgrow a JS double. Parse with BigInt, and
 * only convert to Number for rendering.
 */
export type Msat = string

export type SourceStatus = 'OK' | 'UNREACHABLE' | 'ERROR' | 'TIMEOUT' | 'SKIPPED'

export interface LndSnapshot {
  channelLocal: Msat
  channelRemote: Msat
  channelUnsettledLocal: Msat
  channelUnsettledRemote: Msat
  channelPendingOpenLocal: Msat
  channelPendingOpenRemote: Msat

  onchainTotal: Msat
  onchainConfirmed: Msat
  onchainUnconfirmed: Msat
  onchainLocked: Msat
  onchainReservedAnchor: Msat

  limbo: Msat
  pendingOpenCount: number
  pendingForceCloseCount: number
  waitingCloseCount: number

  blockHeight: number
  syncedToChain: boolean
  syncedToGraph: boolean
  numActiveChannels: number
  numInactiveChannels: number
  numPendingChannels: number
  version: string
}

export interface MintSnapshot {
  unit: string
  issued: Msat
  redeemed: Msat
  feeCollected: Msat
  proofsPending: Msat
  proofsPendingCount: number
  onchainBalance: Msat
  onchainDeposits: Msat
  onchainWithdrawn: Msat
  /** Committed-but-unsettled on-chain melts. Already subtracted from onchainBalance. */
  onchainInflight: Msat | null
  onchainInflightCount: number | null
  /** In flight beyond the trust window — reported, not subtracted. */
  onchainInflightStale: Msat | null
  onchainInflightStaleCount: number | null
  onchainInflightOldestSec: number | null
  onchainQuotes: number

  /**
   * The BDK wallet as measured over CDK's gRPC endpoint.
   *
   * Null means NOT MEASURED — either MINT_RPC_HOST is unset, or the call failed
   * on that tick. Never rendered as zero: an unread wallet and an empty one are
   * different findings.
   */
  walletConfirmed: Msat | null
  walletTrustedPending: Msat | null
  /** Inbound and still reversible. Excluded from reserves — shown, not added. */
  walletUntrustedPending: Msat | null
  walletImmature: Msat | null
  /** confirmed + trustedPending — the figure reserves actually use. */
  walletTrustedSpendable: Msat | null
  walletTotal: Msat | null
  walletNetwork: string | null
  walletSyncedHeight: number | null

  /** Confirmed deposits owed ecash that the mint has not booked yet. A liability. */
  depositsAwaitingCredit: Msat | null
  depositsAwaitingCreditCount: number | null
  /** Confirmed deposits matching no mint quote — operator liquidity. NOT a liability. */
  depositsUnattributed: Msat | null
  depositsUnattributedCount: number | null
  unclaimedMintQuotes: Msat
  /**
   * On-chain share of unclaimedMintQuotes. Already inside it — a breakdown, not a
   * term. Null on observations recorded before it was collected: not measured,
   * which is not the same as none.
   */
  unclaimedOnchain: Msat | null
  overIssuedMintQuotes: Msat
  pendingMeltQuotes: Msat
  sagasInFlight: number
  meltRequestsInFlight: number
  keysetsActive: number
  keysetsTotal: number
  keysetBreakdown: KeysetRow[] | null
}

export interface Reconciliation {
  unit: string
  totalNodeBalance: Msat
  coldStorage: Msat
  mintOnchain: Msat
  /** Where mintOnchain came from. Null on rows written before the column existed. */
  mintOnchainBasis: 'WALLET' | 'LEDGER' | null
  /** The ledger estimate, kept as a cross-check even when WALLET is the basis. */
  mintOnchainLedger: Msat | null
  mintBalance: Msat
  /** Declared issued ecash that can never be redeemed. Added to own capital. */
  provablyUnspendable: Msat
  proofsPending: Msat
  ownCapital: Msat
  unclaimed: Msat
  /** Confirmed on-chain deposits the mint owes ecash for but has not booked. */
  depositsAwaitingCredit: Msat
  mintFeesCollected: Msat
  deltaOwnCapital: Msat | null
  deltaUnclaimed: Msat | null
  deltaDepositsAwaitingCredit: Msat | null
  deltaColdStorage: Msat | null
  deltaProvablyUnspendable: Msat | null
  deltaMintFees: Msat | null
  remainingDelta: Msat | null
}

export interface KeysetRow {
  keysetId: string
  unit: string
  active: boolean
  inputFeePpk: number
  validFrom: number
  issued: Msat
  redeemed: Msat
  feeCollected: Msat
}

export interface Observation {
  id: number
  observedAt: string
  skewMs: number
  durationMs: number
  lndStatus: SourceStatus
  mintStatus: SourceStatus
  lndError: string | null
  mintError: string | null
  lnd: LndSnapshot | null
  mints: MintSnapshot[]
  reconciliation: Reconciliation | null
}

export interface TimeseriesPoint {
  t: string
  unit: string
  totalNodeBalance: Msat
  coldStorage: Msat
  mintOnchain: Msat
  mintBalance: Msat
  proofsPending: Msat
  ownCapital: Msat
  unclaimed: Msat
  remainingDelta: Msat | null
}

export interface DeltaResponse {
  minutes: number
  samples: number
  from?: string
  to?: string
  elapsedMs: number | null
  maxGapMs: number | null
  deltas: {
    unit: string
    /** Asset and liability sides of the window. See /deltas — served, not differenced here. */
    reserves: Msat
    ecashIssued: Msat
    proofsPending: Msat
    /** Declared unspendable ecash. Explained, like cold storage. */
    provablyUnspendable: Msat
    ownCapital: Msat
    unclaimed: Msat
    /** Same liability as `unclaimed`, before the mint booked it. */
    depositsAwaitingCredit: Msat
    coldStorage: Msat
    mintFees: Msat
    remaining: Msat
  } | null
}

export type AlertStatus = 'PENDING' | 'FIRING' | 'RESOLVED'
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL'

export interface Alert {
  id: number
  ruleId: string
  dedupeKey: string
  status: AlertStatus
  severity: Severity
  title: string
  detail: string | null
  firedAt: string | null
  resolvedAt: string | null
  lastEvaluatedAt: string
  notifyCount: number
}

export interface CollectorStatus {
  observations: number
  latestObservedAt: string | null
  latestLndStatus: SourceStatus | null
  latestMintStatus: SourceStatus | null
  lastSuccessfulLndAt: string | null
}
