/**
 * Route-based tenant resolution (Part 2 of the public-page caching effort).
 *
 * Today every public tenant page resolves its tenant from the `x-tenant-id`
 * request header (set by proxy.ts from the subdomain). Reading that header goes
 * through Next.js's `headers()` Dynamic API, which forces per-request dynamic
 * rendering — so the page can never be CDN/ISR-cached, regardless of any
 * `revalidate` export (confirmed live; see the masjidweb-public-page-caching
 * memory).
 *
 * This module gates an alternative: proxy.ts rewrites `tenant.<suffix>/path`
 * to an internal `/<prefix>/<tenantId>/path`, and a dedicated route tree reads
 * the tenant from the `[tenantId]` route *param* (params don't force dynamic
 * rendering). The tenant id lives in the rewritten URL path, so it is part of
 * the cache key — different tenants resolve to different paths and therefore
 * different cache entries, structurally preventing cross-tenant cache bleed.
 *
 * Everything here is OFF by default. Rollback = unset MW_ROUTE_TENANT_RESOLUTION
 * and redeploy (same pattern as MW_TENANT_RLS_ENFORCE) — the old header-based
 * routes are never touched and remain the default.
 */

/**
 * Internal URL prefix for the cacheable, param-based tenant routes. Chosen to
 * be MasjidWeb-namespaced and collision-safe with real page slugs. Direct
 * external requests to this prefix are 404'd by proxy.ts — it is only ever
 * reached via an internal `NextResponse.rewrite` (which does not re-run
 * middleware), so the `[tenantId]` segment always carries the proxy-resolved,
 * trusted tenant id, never a client-supplied one.
 *
 * Matches the route tree at `app/(site)/mw-tenant/[tenantId]/...`.
 */
export const TENANT_ROUTE_PREFIX = '/mw-tenant';

export type RouteTenantResolutionMode = 'off' | 'canary' | 'on';

/**
 * Resolve the current mode from env. Unknown / unset values fall back to 'off'
 * so the feature is inert unless deliberately enabled.
 *
 *   - `off`    (default): header-based resolution only. Zero behaviour change.
 *   - `canary`: rewrite only for hosts listed in MW_ROUTE_TENANT_CANARY_HOSTS.
 *   - `on`     : rewrite for every tenant public page (final rollout).
 */
export function routeTenantResolutionMode(
  env: NodeJS.ProcessEnv = process.env,
): RouteTenantResolutionMode {
  const raw = env.MW_ROUTE_TENANT_RESOLUTION?.trim().toLowerCase();
  if (raw === 'on' || raw === 'canary') return raw;
  return 'off';
}

/** Parse the comma-separated canary host allowlist into a normalised set. */
function canaryHosts(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.MW_ROUTE_TENANT_CANARY_HOSTS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/:\d+$/, ''))
      .filter(Boolean),
  );
}

/**
 * Whether a request for `host` should be rewritten onto the param-based tenant
 * route. `host` is the raw Host header value (port is stripped for matching).
 */
export function shouldRewriteToTenantRoute(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = routeTenantResolutionMode(env);
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  const normalized = host.toLowerCase().replace(/:\d+$/, '');
  return canaryHosts(env).has(normalized);
}

/**
 * Whether `pathname` targets the internal tenant-route prefix. Used by the
 * proxy guard to 404 direct external probes of the internal routes.
 */
export function isInternalTenantRoutePath(pathname: string): boolean {
  return (
    pathname === TENANT_ROUTE_PREFIX ||
    pathname.startsWith(`${TENANT_ROUTE_PREFIX}/`)
  );
}

/**
 * Build the internal rewrite path for a public-page request.
 *
 *   buildTenantRoutePath('<tid>', '/')            -> '/mw-tenant/<tid>'
 *   buildTenantRoutePath('<tid>', '/about')       -> '/mw-tenant/<tid>/about'
 *   buildTenantRoutePath('<tid>', '/blog/post-1') -> '/mw-tenant/<tid>/blog/post-1'
 *
 * The original path is appended verbatim, so the real page slug is fully
 * preserved as the `[...slug]` segment(s) of the target route.
 */
export function buildTenantRoutePath(tenantId: string, pathname: string): string {
  const suffix = pathname === '/' ? '' : pathname;
  return `${TENANT_ROUTE_PREFIX}/${tenantId}${suffix}`;
}
