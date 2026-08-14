/**
 * The dashboard proxies /api/* to the backend via a route handler, NOT via
 * `rewrites()` — see src/pages/api/[...path].ts for why.
 *
 * Short version: `rewrites()` is evaluated at build time and baked into
 * routes-manifest.json, so it cannot be reconfigured by restart. A route handler
 * reads process.env per request, which is what "configurable over the env with a
 * simple restart" actually requires.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
}

export default nextConfig
