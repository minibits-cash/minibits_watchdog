import { getLndClient } from './lndClient'
import { Source } from '../types'
import { amountToMsat, satToMsat } from '../../utils/money'
import { log } from '../../services/logService'

export interface LndReading {
    // ChannelBalanceResponse
    channelLocal: bigint
    channelRemote: bigint
    channelUnsettledLocal: bigint
    channelUnsettledRemote: bigint
    channelPendingOpenLocal: bigint
    channelPendingOpenRemote: bigint

    // WalletBalanceResponse
    onchainTotal: bigint
    onchainConfirmed: bigint
    onchainUnconfirmed: bigint
    onchainLocked: bigint
    onchainReservedAnchor: bigint

    // PendingChannelsResponse
    limbo: bigint
    pendingOpenCount: number
    pendingForceCloseCount: number
    waitingCloseCount: number

    // GetInfoResponse
    blockHeight: number
    syncedToChain: boolean
    syncedToGraph: boolean
    numActiveChannels: number
    numInactiveChannels: number
    numPendingChannels: number
    version: string

    raw: Record<string, unknown>
}

/**
 * Read a field that must exist, trying camelCase and snake_case spellings.
 *
 * Deliberately throws rather than defaulting to zero. If LND renames a field
 * across versions, a silent zero would be recorded as a real balance and show
 * up as a large fabricated deficit — the exact false alarm this tool exists to
 * avoid. Failing the read instead surfaces it as a collector error.
 *
 * Presence is tested on the key, not the value: lnrpc types several balance
 * fields as nullable, and a null there means "genuinely empty" (a node with no
 * channels), which is zero. Only an absent key indicates a schema change.
 */
function req(obj: any, ...names: string[]): any {
    if (obj === null || obj === undefined) {
        throw new Error(`LND response missing (looking for ${names.join(' / ')})`)
    }
    for (const name of names) {
        if (name in obj) return obj[name]
    }
    throw new Error(
        `LND response missing expected field ${names.join(' / ')}; present keys: ${Object.keys(obj).join(', ')}`,
    )
}

/** Optional field — genuinely absent in some LND builds, zero is correct. */
function opt(obj: any, ...names: string[]): any {
    if (!obj) return undefined
    for (const name of names) {
        const v = obj[name]
        if (v !== undefined && v !== null) return v
    }
    return undefined
}

function count(v: unknown): number {
    return Array.isArray(v) ? v.length : 0
}

export class LndSource implements Source<LndReading> {
    readonly name = 'lnd'

    async collect(): Promise<LndReading> {
        const lnd = getLndClient().lightning

        const [channelBalance, walletBalance, pendingChannels, info] = await Promise.all([
            lnd.channelBalance({}),
            lnd.walletBalance({}),
            lnd.pendingChannels({}),
            lnd.getInfo({}),
        ])

        log.trace('[LndSource] raw responses', { channelBalance, walletBalance })

        const reading: LndReading = {
            // localBalance/remoteBalance are Amount { sat, msat }; the older
            // top-level `balance` field is plain sat and is not used here.
            channelLocal: amountToMsat(req(channelBalance, 'localBalance', 'local_balance')),
            channelRemote: amountToMsat(req(channelBalance, 'remoteBalance', 'remote_balance')),
            channelUnsettledLocal: amountToMsat(
                req(channelBalance, 'unsettledLocalBalance', 'unsettled_local_balance'),
            ),
            channelUnsettledRemote: amountToMsat(
                req(channelBalance, 'unsettledRemoteBalance', 'unsettled_remote_balance'),
            ),
            channelPendingOpenLocal: amountToMsat(
                req(channelBalance, 'pendingOpenLocalBalance', 'pending_open_local_balance'),
            ),
            channelPendingOpenRemote: amountToMsat(
                req(channelBalance, 'pendingOpenRemoteBalance', 'pending_open_remote_balance'),
            ),

            // WalletBalance fields are plain sat strings.
            onchainTotal: satToMsat(req(walletBalance, 'totalBalance', 'total_balance')),
            onchainConfirmed: satToMsat(req(walletBalance, 'confirmedBalance', 'confirmed_balance')),
            onchainUnconfirmed: satToMsat(req(walletBalance, 'unconfirmedBalance', 'unconfirmed_balance')),
            onchainLocked: satToMsat(opt(walletBalance, 'lockedBalance', 'locked_balance') ?? '0'),
            onchainReservedAnchor: satToMsat(
                opt(walletBalance, 'reservedBalanceAnchorChan', 'reserved_balance_anchor_chan') ?? '0',
            ),

            limbo: satToMsat(req(pendingChannels, 'totalLimboBalance', 'total_limbo_balance')),
            pendingOpenCount: count(opt(pendingChannels, 'pendingOpenChannels', 'pending_open_channels')),
            pendingForceCloseCount: count(
                opt(pendingChannels, 'pendingForceClosingChannels', 'pending_force_closing_channels'),
            ),
            waitingCloseCount: count(opt(pendingChannels, 'waitingCloseChannels', 'waiting_close_channels')),

            blockHeight: Number(req(info, 'blockHeight', 'block_height')),
            syncedToChain: Boolean(opt(info, 'syncedToChain', 'synced_to_chain') ?? false),
            syncedToGraph: Boolean(opt(info, 'syncedToGraph', 'synced_to_graph') ?? false),
            numActiveChannels: Number(opt(info, 'numActiveChannels', 'num_active_channels') ?? 0),
            numInactiveChannels: Number(opt(info, 'numInactiveChannels', 'num_inactive_channels') ?? 0),
            numPendingChannels: Number(opt(info, 'numPendingChannels', 'num_pending_channels') ?? 0),
            version: String(opt(info, 'version') ?? 'unknown'),

            raw: {
                channelBalance,
                walletBalance,
                // Channel arrays can be large and are not needed verbatim; keep the
                // aggregate and the per-channel identifiers only.
                pendingChannels: {
                    totalLimboBalance: opt(pendingChannels, 'totalLimboBalance', 'total_limbo_balance'),
                    pendingOpenChannels: opt(pendingChannels, 'pendingOpenChannels', 'pending_open_channels'),
                    pendingForceClosingChannels: opt(
                        pendingChannels,
                        'pendingForceClosingChannels',
                        'pending_force_closing_channels',
                    ),
                    waitingCloseChannels: opt(
                        pendingChannels,
                        'waitingCloseChannels',
                        'waiting_close_channels',
                    ),
                },
                info,
            },
        }

        return reading
    }
}

/**
 * Channel + Wallet + Limbo — the sheet's "Total node balance".
 *
 * ── Why in-flight HTLCs are deliberately NOT added ───────────────────────────
 *
 * Tempting, because a payment in flight has left `local_balance` and the node
 * looks briefly poorer. But the reconciliation identity already covers both
 * directions, and adding them would double-count:
 *
 *   Outgoing (a melt paying a Lightning invoice) — `local_balance` drops when the
 *   HTLC locks, and CDK marks the proofs PENDING at essentially the same moment.
 *   `+ Proofs pending` cancels the drop on the liability side, so the identity
 *   already holds. Adding an asset-side term too would compensate twice.
 *
 *   Incoming (a mint quote being paid) — while the HTLC is in flight the value is
 *   in neither `local_balance` nor the mint's books, so nothing has moved. On
 *   settlement, reserves and `unclaimed` rise together and cancel. Recognising it
 *   early would manufacture transient drift that does not exist today.
 *
 * Note also that lnd splits pending HTLCs by direction: `unsettled_local_balance`
 * is INCOMING value; an outgoing melt sits in `unsettled_remote_balance`. So
 * local unsettled does not even contain the case it would most plausibly be
 * reached for.
 *
 * Both fields are still captured on every snapshot (SPEC §3.5, store raw) and
 * shown in the dashboard's reserves drill-down — visible for diagnosis, excluded
 * from the arithmetic.
 */
export function totalNodeBalance(r: LndReading): bigint {
    return r.channelLocal + r.onchainTotal + r.limbo
}
