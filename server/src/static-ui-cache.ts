import path from "node:path";

/**
 * Cache-Control override for non-hashed UI static files (everything outside
 * /assets, which is content-hashed and immutable). Three files must always be
 * revalidated:
 *
 * - `index.html` must never outlive the asset hashes it points at.
 * - `sw.js` is the browser's only channel for updating an installed service
 *   worker: clients re-fetch this exact URL to discover new worker code, so
 *   any cache TTL here delays every client's update by that long on top of
 *   the browser's own update timer.
 * - `site.webmanifest` decides whether the browser treats the origin as
 *   installable at all. A stale copy keeps clients on the previous
 *   `display`, name, or icon set for the TTL, so an operator who deploys a
 *   manifest fix still sees the old install behaviour and has no way to tell
 *   that the deploy landed.
 *
 * Returns undefined for files where the middleware's default TTL applies.
 */
const ALWAYS_REVALIDATED = new Set(["index.html", "sw.js", "site.webmanifest"]);

export function staticUiCacheControl(filePath: string): "no-cache" | undefined {
  return ALWAYS_REVALIDATED.has(path.basename(filePath)) ? "no-cache" : undefined;
}
