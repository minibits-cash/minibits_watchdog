import fs from 'node:fs'
import { config } from '../../config'
import { log } from '../../services/logService'

/**
 * Minimal bitcoind JSON-RPC client — two read methods, nothing else.
 *
 * ── Why the watchdog needs a chain source at all ─────────────────────────────
 *
 * CDK's wallet RPC has no join between transactions and addresses:
 * `WalletTransaction` carries no output addresses, `WalletAddress` carries no
 * txids. So "did this deposit land on an address belonging to a mint quote?"
 * — the question that separates a user's mint payment from the operator moving
 * liquidity — cannot be answered from CDK alone until CDK books the payment,
 * which is precisely when the ambiguity ends anyway.
 *
 * One `getrawtransaction` answers it on arrival.
 *
 * ── Why bitcoind rather than a public explorer ───────────────────────────────
 *
 * A block explorer would work and the call volume is trivial (~3/day), but
 * asking a third party about every deposit to the mint's wallet, minutes after
 * it confirms, from the mint's own host, discloses the reserve wallet's deposit
 * graph and — through the timing — who the recipient is. bitcoind is already
 * present (CDK's BDK backend uses it), so the private answer is also the
 * authoritative one, with no new trust dependency.
 *
 * Optional throughout. Unset, the collector falls back to inference, which is
 * conservative rather than wrong — see onchainDeposits.ts.
 */

export interface TxOutput {
    vout: number
    address: string | null
    valueSat: bigint
}

class BitcoinRpcError extends Error {
    /**
     * True when the call never got an answer OUT of bitcoind — bad URL, refused
     * connection, timeout, rejected credentials, HTTP-level failure.
     *
     * The distinction drives the retry cap in onchainDeposits.ts and it is not
     * cosmetic. A transport failure says nothing whatsoever about whether a
     * transaction is classifiable, so counting it against a per-transaction
     * attempt budget converts an outage into permanent data loss: a scheme-less
     * BITCOIN_RPC_URL once burned all 12 attempts on 18 deposits in an hour and
     * stranded 2,279,267 sat as a liability that fixing bitcoind could not clear.
     *
     * An error bitcoind itself returned (`body.error`) is NOT transport: "Block
     * not available (pruned data)" is a real, permanent answer about that
     * transaction, and should count.
     */
    readonly transport: boolean

    constructor(message: string, transport = false) {
        super(message)
        this.transport = transport
    }
}

/** Did this failure mean "bitcoind never answered", rather than "bitcoind said no"? */
export function isTransportFailure(e: unknown): boolean {
    return e instanceof BitcoinRpcError && e.transport
}

let cookieCache: { path: string; mtimeMs: number; value: string } | undefined

/**
 * bitcoind rewrites .cookie on every restart, so it is re-read when the file
 * changes rather than cached for the process lifetime — otherwise the first
 * bitcoind restart would silently break lookups until the watchdog restarted
 * too, and the symptom (401) looks nothing like the cause.
 */
function authHeader(): string {
    const { user, password, cookiePath } = config.bitcoinRpc

    if (cookiePath) {
        const stat = fs.statSync(cookiePath)
        if (!cookieCache || cookieCache.path !== cookiePath || cookieCache.mtimeMs !== stat.mtimeMs) {
            cookieCache = {
                path: cookiePath,
                mtimeMs: stat.mtimeMs,
                value: fs.readFileSync(cookiePath, 'utf8').trim(),
            }
            log.info('[bitcoinRpc] loaded cookie file', { path: cookiePath })
        }
        return `Basic ${Buffer.from(cookieCache.value).toString('base64')}`
    }

    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

async function call<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.bitcoinRpc.timeoutMs)

    try {
        const res = await fetch(config.bitcoinRpc.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: authHeader(),
            },
            body: JSON.stringify({ jsonrpc: '1.0', id: 'minibits_watchdog', method, params }),
            signal: controller.signal,
        })

        if (res.status === 401) {
            throw new BitcoinRpcError(
                'bitcoind rejected the credentials (401). Check BITCOIN_RPC_USER/PASSWORD, or ' +
                    'BITCOIN_RPC_COOKIE if the node uses cookie auth.',
                true,
            )
        }

        // bitcoind returns 500 WITH a useful JSON body for application errors,
        // so the body is preferred over the status line where one exists.
        const body = (await res.json().catch(() => null)) as any

        if (body?.error) {
            throw new BitcoinRpcError(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
        }
        if (!res.ok) {
            throw new BitcoinRpcError(`${method}: HTTP ${res.status}`, true)
        }

        return body.result as T
    } catch (e: any) {
        if (e?.name === 'AbortError') {
            throw new BitcoinRpcError(`${method}: timed out after ${config.bitcoinRpc.timeoutMs}ms`, true)
        }
        // Anything thrown by fetch itself never reached the node: an unparseable
        // URL, DNS failure, refused connection, socket reset.
        throw e instanceof BitcoinRpcError ? e : new BitcoinRpcError(`${method}: ${String(e?.message ?? e)}`, true)
    } finally {
        clearTimeout(timer)
    }
}

export interface TxDetails {
    outputs: TxOutput[]
    /**
     * Txids this transaction spent from.
     *
     * The co-spend evidence. When the mint's wallet consumes a dusted UTXO
     * alongside its own, the common-input-ownership heuristic lets whoever sent
     * that dust attribute every other input address to the mint. Knowing which
     * txids an outgoing transaction drew on is what makes that detectable.
     */
    inputTxids: string[]
}

/**
 * Inputs and output addresses of a confirmed transaction.
 *
 * Looked up via the block hash at its known confirmation height, which is what
 * makes this work on a node WITHOUT `-txindex`: bitcoind will find any
 * transaction if told which block to look in, and CDK's wallet already tells us
 * the height. Requiring txindex would have meant a full reindex on most nodes.
 */
export async function txDetails(txid: string, confirmationHeight: number): Promise<TxDetails> {
    const blockHash = await call<string>('getblockhash', [confirmationHeight])
    const tx = await call<any>('getrawtransaction', [txid, true, blockHash])

    const vins = Array.isArray(tx?.vin) ? tx.vin : []
    // A coinbase input has no `txid`, and neither does a malformed one.
    const inputTxids: string[] = [
        ...new Set<string>(
            vins
                .map((v: any) => v?.txid)
                .filter((t: unknown): t is string => typeof t === 'string'),
        ),
    ]

    const vouts = Array.isArray(tx?.vout) ? tx.vout : []

    const outputs: TxOutput[] = vouts.map((v: any, i: number) => ({
        vout: Number(v?.n ?? i),
        // `address` since Core 22; `addresses[]` on older builds. A script with
        // no standard address (bare multisig, OP_RETURN) yields null, which is a
        // legitimate output rather than a parse failure.
        address:
            (v?.scriptPubKey?.address as string | undefined) ??
            (Array.isArray(v?.scriptPubKey?.addresses) ? v.scriptPubKey.addresses[0] : undefined) ??
            null,
        // BTC decimal → sat. Rounded rather than truncated: 0.001 arrives as
        // 0.00099999999 in a double often enough to matter at this scale.
        valueSat: BigInt(Math.round(Number(v?.value ?? 0) * 1e8)),
    }))

    return { outputs, inputTxids }
}

/** Liveness and reachability, for the probe and the startup path. */
export async function chainInfo(): Promise<{ chain: string; blocks: number; pruned: boolean }> {
    const info = await call<any>('getblockchaininfo', [])
    return {
        chain: String(info?.chain ?? 'unknown'),
        blocks: Number(info?.blocks ?? 0),
        pruned: Boolean(info?.pruned ?? false),
    }
}

/**
 * Cheapest possible liveness check — one integer, no block data.
 *
 * Exists so the chain source can be checked on EVERY tick rather than only when
 * there is a deposit to classify. Without it a dead bitcoind is invisible until
 * a deposit happens to arrive, and by then it has already moved the books:
 * an unclassifiable deposit is booked as `depositsAwaitingCredit`, so the
 * failure mode is not "unknown" but "the mint owes this".
 */
export async function chainTip(): Promise<number> {
    return await call<number>('getblockcount', [])
}
