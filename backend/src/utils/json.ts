/**
 * Prisma returns `BigInt` for int8 columns, and `JSON.stringify` throws on
 * BigInt rather than serialising it. Every monetary value in this app is a
 * BigInt, so responses need an explicit replacer.
 *
 * Emitted as a string rather than a number: sat values fit in a double today,
 * but msat totals across a growing mint will not stay that way, and silently
 * losing precision in the reserve figures is the one failure this tool must
 * not have.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
    return typeof value === 'bigint' ? value.toString() : value
}

export function serialize(payload: unknown): string {
    return JSON.stringify(payload, bigintReplacer)
}
