#!/usr/bin/env node
/**
 * Stop the watchdog's locally-running backend and frontend.
 *
 * ── Why not kill by port ────────────────────────────────────────────────────
 *
 * The obvious `lsof -ti:3005 | xargs kill` is actively dangerous here: on a dev
 * machine those ports are held by the SSH tunnel forwarding PRODUCTION, not by a
 * local server. Killing by port would drop the tunnel and leave production
 * looking down. Ports are also configurable (PORT / BACKEND_URL), so the numbers
 * are not knowable from here anyway.
 *
 * ── What it matches instead ─────────────────────────────────────────────────
 *
 * A process is stopped only if BOTH hold:
 *   1. its command line looks like one of this project's entrypoints, and
 *   2. its working directory is inside THIS repository.
 *
 * The cwd test is what makes it safe: another project's `next dev`, or an
 * unrelated `node dist/index.js`, cannot match. Neither can the SSH tunnel,
 * which fails both tests.
 *
 * Covers `start:prod` as well as the watch modes, because "the local server" is
 * often started from the built bundle.
 */
import { execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Identifies this project's server entrypoints.
 *
 * Matching the argument alone is not enough: a `grep dist/index.js` run from
 * this directory satisfies both the substring and the cwd test, so a naive
 * matcher kills the caller's own pipeline. (Observed, not hypothetical.) The
 * program itself must therefore be a node runtime — which excludes greps,
 * editors, and anything else that merely mentions the path.
 */
const ENTRYPOINT_ARGS = [/\bts-node-dev\b/, /\bnext\s+(dev|start)\b/, /\bdist\/index\.js\b/]

function isProjectServer(command) {
    const [program] = command.split(/\s+/)
    const base = program.split('/').pop() ?? ''

    // Next renames its worker process to "next-server (vX.Y.Z)".
    if (base.startsWith('next-server')) return true
    if (base !== 'node' && base !== 'node.exe') return false

    return ENTRYPOINT_ARGS.some((re) => re.test(command))
}

const sh = (cmd, args) => {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
        return ''
    }
}

/** Working directory of a pid, or null if it cannot be determined. */
function cwdOf(pid) {
    if (process.platform === 'linux') {
        try {
            return readlinkSync(`/proc/${pid}/cwd`)
        } catch {
            return null
        }
    }
    // macOS has no /proc; lsof -Fn prints the cwd on a line prefixed with "n".
    const out = sh('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'])
    const line = out.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
}

const self = process.pid
const rows = sh('ps', ['-eo', 'pid=,command=']).split('\n')

const targets = []
for (const row of rows) {
    const m = row.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue

    const pid = Number(m[1])
    const command = m[2]

    if (pid === self || pid === process.ppid) continue
    if (!isProjectServer(command)) continue

    const cwd = cwdOf(pid)
    if (!cwd || (cwd !== REPO && !cwd.startsWith(`${REPO}/`))) continue

    targets.push({ pid, command: command.slice(0, 100) })
}

if (targets.length === 0) {
    console.log('No local watchdog servers running.')
    process.exit(0)
}

const alive = (pid) => {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

for (const t of targets) {
    console.log(`stopping ${t.pid}  ${t.command}`)
    try {
        process.kill(t.pid, 'SIGTERM')
    } catch {
        /* already gone */
    }
}

// Give SIGTERM a moment, then insist. A wedged server that ignores TERM would
// otherwise hold its port and make the next `yarn dev` fail confusingly.
//
// Atomics.wait rather than shelling out to `sleep`: this is the one place the
// script must block, and spawning a process to do it is both slower and fragile
// in sandboxed shells where `sleep` may be unavailable.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const deadline = Date.now() + 5000
while (Date.now() < deadline && targets.some((t) => alive(t.pid))) {
    sleepSync(200)
}

for (const t of targets.filter((t) => alive(t.pid))) {
    console.log(`  ${t.pid} ignored SIGTERM — sending SIGKILL`)
    try {
        process.kill(t.pid, 'SIGKILL')
    } catch {
        /* already gone */
    }
}

console.log(`Stopped ${targets.length} process(es).`)
