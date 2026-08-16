import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { config } from '../../config'
import { satToMsat } from '../../utils/money'
import { log } from '../../services/logService'

/**
 * Client for CDK's mint management gRPC endpoint — read methods only.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The mint's on-chain reserves were previously inferred from CDK's own ledger
 * (paid on-chain mint quotes, less booked melt payouts, less broadcast melts).
 * That figure audits the mint's books against themselves: it moves only when
 * CDK writes a row, so coins leaving the BDK wallet by any route CDK did not
 * book are invisible to it — an operator sweep, an unbooked fee, a CDK bug.
 * Undeclared outflow is the single thing this tool exists to catch, so an
 * asset figure that cannot express one is a blind spot rather than a
 * conservative estimate.
 *
 * `WalletService.GetBalance` reads the wallet itself, which closes that gap.
 * The ledger figure is still collected, and its divergence from the wallet is
 * now a signal in its own right (see `mint_wallet_ledger_divergence`).
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 *
 * The endpoint also serves CDK's write-capable management service — rotating
 * keysets, editing mint metadata — and gRPC has no per-method credential to
 * scope that away, so this cannot be the equivalent of LND's readonly.macaroon.
 * What it can be is a client that does not know how: only the read-only
 * `WalletService` is vendored in proto/cdk-mint-wallet.proto, so no management
 * method has a stub here to call by accident. The real boundary is network
 * reach — keep the listener on loopback.
 */

export interface MintWalletBalance {
    /** All amounts msat, normalised at this edge like every other source. */
    confirmed: bigint
    trustedPending: bigint
    untrustedPending: bigint
    immature: bigint
    /** confirmed + trustedPending. The reserve figure — see reconciliation.ts. */
    trustedSpendable: bigint
    total: bigint
    network: string
    /** The wallet's own chain tip. Cross-checked against LND's, which is independent. */
    syncedHeight: number
}

/**
 * The vendored proto has to be found at runtime, and "runtime" is two different
 * layouts: ts-node-dev executing src/, and a single esbuild bundle at dist/.
 * Both resolve relative to this module, so neither depends on the working
 * directory; cwd is kept only as a last resort for an unusual launcher.
 */
function resolveProtoPath(): string {
    const candidates = [
        // esbuild bundle: dist/index.js → backend/proto
        fileURLToPath(new URL('../proto/cdk-mint-wallet.proto', import.meta.url)),
        // ts-node-dev: src/sources/mint/ → backend/proto
        fileURLToPath(new URL('../../../proto/cdk-mint-wallet.proto', import.meta.url)),
        path.join(process.cwd(), 'proto', 'cdk-mint-wallet.proto'),
    ]

    for (const c of candidates) {
        if (fs.existsSync(c)) return c
    }

    throw new Error(
        `Cannot find cdk-mint-wallet.proto. Looked in:\n  ${candidates.join('\n  ')}\n` +
            `It ships in the repo at backend/proto/ — a deploy that copies only dist/ will miss it.`,
    )
}

interface RawBalance {
    confirmed_sat: string
    trusted_pending_sat: string
    untrusted_pending_sat: string
    immature_sat: string
    trusted_spendable_sat: string
    total_sat: string
    network: string
    synced_height: number
}

interface RawTx {
    txid: string
    received_sat: string
    sent_sat: string
    fee_sat?: string
    balance_delta_sat: string
    confirmation_height?: number
    confirmation_time?: string
    first_seen?: string
}

interface RawTxList {
    transactions: RawTx[]
    total: string
}

/** Minimal shape of the generated stub — only the methods we actually call. */
interface WalletServiceClient extends grpc.Client {
    GetBalance(
        req: Record<string, never>,
        metadata: grpc.Metadata,
        options: grpc.CallOptions,
        cb: (err: grpc.ServiceError | null, res?: RawBalance) => void,
    ): void
    ListTransactions(
        req: { limit: number; offset: number },
        metadata: grpc.Metadata,
        options: grpc.CallOptions,
        cb: (err: grpc.ServiceError | null, res?: RawTxList) => void,
    ): void
}

/**
 * cdk-mintd rejects any request without `x-cdk-protocol-version`, and compares
 * it by EXACT STRING — not semver, so "1.0.0" and "1.0" are both wrong if the
 * server says otherwise, and a patch bump on CDK's side breaks the call outright
 * (`FAILED_PRECONDITION: Protocol version mismatch: server=…, client=…`).
 *
 * Overridable by env precisely because of that. The server's error names the
 * version it wants, so an operator can read it out of the alert and set
 * MINT_RPC_PROTOCOL_VERSION without waiting on a watchdog release — which
 * matters when the alternative is reserve monitoring staying dark.
 */
function callMetadata(): grpc.Metadata {
    const md = new grpc.Metadata()
    md.set('x-cdk-protocol-version', config.mintRpc.protocolVersion)
    return md
}

let client: WalletServiceClient | undefined

function getClient(): WalletServiceClient {
    if (client) return client

    const definition = protoLoader.loadSync(resolveProtoPath(), {
        // uint64 as String, not Number: sat totals are safe in a double today,
        // but this is the file where a silent precision loss would be least
        // noticed and most expensive. BigInt conversion happens below.
        longs: String,
        // Keep the proto's snake_case field names rather than camelCasing them,
        // so the TypeScript shape above can be diffed against the .proto line by
        // line without a mental transform.
        keepCase: true,
        // proto3 omits zero-valued fields on the wire. Without defaults an empty
        // wallet returns `undefined` for every balance, which BigInt() would
        // reject — a zero balance is a legitimate reading, not an error.
        defaults: true,
        enums: String,
        oneofs: true,
    })

    const pkg = grpc.loadPackageDefinition(definition) as any
    const Ctor = pkg?.cdk_mint_wallet_v1?.WalletService

    if (typeof Ctor !== 'function') {
        throw new Error(
            'cdk_mint_wallet_v1.WalletService is not in the loaded proto — the vendored ' +
                'proto/cdk-mint-wallet.proto has drifted from CDK.',
        )
    }

    const target = `${config.mintRpc.host}:${config.mintRpc.port}`

    client = new Ctor(target, buildCredentials()) as WalletServiceClient

    log.info('[mintRpc] client created', {
        target,
        tls: config.mintRpc.tlsCaPath ? 'mutual' : 'insecure',
    })

    return client
}

function buildCredentials(): grpc.ChannelCredentials {
    if (!config.mintRpc.tlsCaPath) {
        // Deliberate, and validated in config.ts as an all-or-nothing choice.
        // cdk-mintd's own default is `allow_insecure` on loopback; when the
        // watchdog reaches it through an SSH tunnel the transport is already
        // authenticated and encrypted by ssh.
        return grpc.credentials.createInsecure()
    }

    const read = (label: string, p: string): Buffer => {
        try {
            return fs.readFileSync(p)
        } catch (e: any) {
            throw new Error(`Cannot read mint RPC ${label} at ${p}: ${String(e?.message ?? e)}`)
        }
    }

    return grpc.credentials.createSsl(
        read('CA certificate', config.mintRpc.tlsCaPath),
        read('client key', config.mintRpc.tlsClientKeyPath),
        read('client certificate', config.mintRpc.tlsClientCertPath),
    )
}

/**
 * Read the BDK wallet balance.
 *
 * Throws on any failure rather than returning a zero or a stale value: a wrong
 * reserve figure is worse than a missing one, because the missing one is
 * visible. The caller records the absence and reconciliation declines to
 * compute a row from it — see mintSource.ts.
 */
export async function readWalletBalance(): Promise<MintWalletBalance> {
    const c = getClient()
    const deadline = new Date(Date.now() + config.mintRpc.timeoutMs)

    const res = await new Promise<RawBalance>((resolve, reject) => {
        c.GetBalance({}, callMetadata(), { deadline }, (err, value) => {
            if (err) {
                reject(new Error(`${err.code ? `${grpc.status[err.code]}: ` : ''}${err.message}`))
                return
            }
            if (!value) {
                reject(new Error('GetBalance returned no value'))
                return
            }
            resolve(value)
        })
    })

    return {
        confirmed: satToMsat(res.confirmed_sat),
        trustedPending: satToMsat(res.trusted_pending_sat),
        untrustedPending: satToMsat(res.untrusted_pending_sat),
        immature: satToMsat(res.immature_sat),
        trustedSpendable: satToMsat(res.trusted_spendable_sat),
        total: satToMsat(res.total_sat),
        network: String(res.network ?? ''),
        syncedHeight: Number(res.synced_height ?? 0),
    }
}

export interface MintWalletTx {
    txid: string
    /** msat, like every other amount once past this edge. */
    receivedMsat: bigint
    sentMsat: bigint
    balanceDeltaMsat: bigint
    confirmationHeight: number | null
    confirmationTime: number | null
}

/**
 * Recent wallet transactions, newest first.
 *
 * `limit` is deliberately modest. This is polled every tick only to notice new
 * transactions — everything already seen is cached in MintWalletTx — so the page
 * needs to be large enough to cover the busiest plausible interval between
 * ticks, not the wallet's history.
 */
export async function listWalletTransactions(limit = 50): Promise<MintWalletTx[]> {
    const c = getClient()
    const deadline = new Date(Date.now() + config.mintRpc.timeoutMs)

    const res = await new Promise<RawTxList>((resolve, reject) => {
        c.ListTransactions({ limit, offset: 0 }, callMetadata(), { deadline }, (err, value) => {
            if (err) {
                reject(new Error(`${err.code ? `${grpc.status[err.code]}: ` : ''}${err.message}`))
                return
            }
            if (!value) {
                reject(new Error('ListTransactions returned no value'))
                return
            }
            resolve(value)
        })
    })

    return (res.transactions ?? []).map((t) => ({
        txid: String(t.txid),
        receivedMsat: satToMsat(t.received_sat),
        sentMsat: satToMsat(t.sent_sat),
        // Signed, so it cannot go through satToMsat's unsigned assumptions
        // unexamined — an outgoing transaction's delta is negative.
        balanceDeltaMsat: BigInt(t.balance_delta_sat ?? 0) * 1000n,
        confirmationHeight: t.confirmation_height ? Number(t.confirmation_height) : null,
        confirmationTime: t.confirmation_time ? Number(t.confirmation_time) : null,
    }))
}

export function closeMintRpcClient(): void {
    if (client) {
        client.close()
        client = undefined
    }
}
