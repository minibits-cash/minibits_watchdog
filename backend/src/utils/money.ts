/**
 * All monetary values are stored internally as msat (BigInt).
 *
 * LND mixes sat and msat across its API — some fields are plain sat strings,
 * some are `Amount { sat, msat }` objects. The CDK mint works in whole units
 * (sat). Normalising once at the collector edge keeps every downstream
 * calculation in a single unit, so reconciliation never accumulates rounding
 * drift in exactly the number we are trying to watch.
 */

export const MSAT_PER_SAT = 1000n

/** Parse an int64-as-string (or number/bigint) that is already denominated in msat. */
export function toMsat(v: string | number | bigint | null | undefined): bigint {
    if (v === null || v === undefined || v === '') return 0n
    if (typeof v === 'bigint') return v
    if (typeof v === 'number') return BigInt(Math.trunc(v))
    return BigInt(v)
}

/** Parse a value denominated in sat and convert to msat. */
export function satToMsat(v: string | number | bigint | null | undefined): bigint {
    return toMsat(v) * MSAT_PER_SAT
}

/**
 * Normalise an LND `Amount { sat, msat }` to msat.
 *
 * Prefers the msat field when present. Falls back to sat, and to treating a
 * bare scalar as sat, since the older balance fields are plain sat strings.
 */
export function amountToMsat(a: unknown): bigint {
    if (a === null || a === undefined) return 0n

    if (typeof a === 'object') {
        const obj = a as Record<string, unknown>
        if (obj.msat !== undefined && obj.msat !== null && obj.msat !== '') {
            return toMsat(obj.msat as string)
        }
        if (obj.sat !== undefined && obj.sat !== null && obj.sat !== '') {
            return satToMsat(obj.sat as string)
        }
        return 0n
    }

    return satToMsat(a as string | number | bigint)
}

/** Floor-divide msat to whole sat. Display only — never feed this back into accounting. */
export function msatToSat(v: bigint): bigint {
    return v / MSAT_PER_SAT
}

/** Format msat as a sat string for logs and banners. */
export function formatSat(v: bigint): string {
    return msatToSat(v).toLocaleString('en-US')
}
