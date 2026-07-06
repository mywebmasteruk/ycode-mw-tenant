/**
 * Pure utility functions used by Next.js proxy/middleware for tenant resolution and routing.
 * Extracted here so they can be unit-tested without mocking Next.js internals.
 */

const RESERVED_SUBDOMAINS = new Set([
  'www', 'admin', 'api', 'mail', 'ftp', 'tenants',
]);

/**
 * Extract a single-label tenant subdomain from the Host header.
 * Returns null if the host doesn't match the expected domain suffix,
 * is a reserved subdomain, or contains nested subdomains.
 */
export function extractSubdomain(
  host: string,
  domainSuffix: string,
): string | null {
  if (!domainSuffix) return null;
  const lower = host.toLowerCase().replace(/:\d+$/, '');
  if (!lower.endsWith(`.${domainSuffix}`)) return null;
  const sub = lower.slice(0, -(domainSuffix.length + 1));
  if (!sub || sub.includes('.') || RESERVED_SUBDOMAINS.has(sub)) return null;
  return sub;
}

const PUBLIC_API_PREFIXES = [
  '/ycode/api/setup/',
  '/ycode/api/supabase/',
  '/ycode/api/v1/',
];

const PUBLIC_COLLECTION_ITEM_SUFFIXES = ['/items/filter', '/items/load-more'];

const PUBLIC_API_EXACT = [
  '/ycode/api/revalidate',
  '/ycode/api/health',
  // MASJIDWEB: RLS mint-health probe (booleans/counters only, no secrets) —
  // polled unauthenticated by the daily isolation canary.
  '/ycode/api/mw-rls-health',
  '/ycode/api/auth/session',
  '/ycode/api/auth/callback',
  // OAuth DCR and token exchange: called by unauthenticated MCP clients.
  // /authorize is intentionally excluded — it requires a user session.
  '/ycode/api/oauth/register',
  '/ycode/api/oauth/token',
];

/**
 * Determine whether an API route is public (skips auth).
 */
export function isPublicApiRoute(pathname: string, method: string): boolean {
  if (pathname === '/ycode/api/form-submissions' && method === 'POST') {
    return true;
  }

  // MASJIDWEB: cache-warm chain hops are server-to-server fetches with no
  // session cookie; the route authenticates itself via an HMAC signature
  // derived from the service-role key (verifyWarmChainSignature). Without
  // this entry the proxy 401s every hop and only the first warm batch of a
  // publish ever runs (confirmed live 2026-07-06).
  if (pathname === '/ycode/api/cache/warm' && method === 'POST') {
    return true;
  }

  if (PUBLIC_API_EXACT.includes(pathname)) return true;
  if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix)))
    return true;

  if (
    method === 'POST' &&
    pathname.startsWith('/ycode/api/collections/') &&
    PUBLIC_COLLECTION_ITEM_SUFFIXES.some((suffix) => pathname.endsWith(suffix))
  ) {
    return true;
  }

  return false;
}

// MASJIDWEB_SEAM: site-api-auth
/**
 * Builder API routes that live OUTSIDE `/ycode/api` (under the `(site)` group
 * at `/api/…`) yet perform authenticated builder actions on tenant data.
 *
 * Upstream Ycode is single-tenant — the whole app sits behind one login, so
 * these routes shipped without their own auth. MasjidWeb serves every tenant's
 * builder on a PUBLIC subdomain, which exposes them to anonymous internet
 * requests. The `/api/templates` POSTs are destructive/exfiltrating:
 *   - POST /api/templates/:id/apply        → wipes + replaces tenant content
 *   - POST /api/templates/export           → dumps tenant content as SQL
 *   - POST /api/templates/export-and-upload→ dumps + ships it to an external svc
 *
 * The GET catalog routes (`/api/templates`, `/api/templates/:id`) return only
 * the shared external template marketplace (no tenant data), so they stay
 * public. Legit callers of the POSTs are the authenticated builder UI
 * (components/templates/*, same-origin fetch → session cookie present);
 * provisioning never calls these (it hits the external template API directly).
 *
 * proxy.ts routes matches through the same `verifyApiAuth` + tenant/JWT
 * alignment it applies to `/ycode/api`.
 */
export function isProtectedSiteApiRoute(pathname: string, method: string): boolean {
  return method === 'POST' && pathname.startsWith('/api/templates/');
}
// MASJIDWEB_SEAM_END

/**
 * Derive Supabase project URL and anon key from env vars.
 */
export function getSupabaseEnvConfig(): {
  url: string;
  anonKey: string;
} | null {
  const anonKey =
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const connectionUrl = process.env.SUPABASE_CONNECTION_URL;

  if (!anonKey || !connectionUrl) return null;

  const match = connectionUrl.match(/\/\/postgres\.([a-z0-9]+):/);
  if (!match) return null;

  return {
    url: `https://${match[1]}.supabase.co`,
    anonKey,
  };
}

/**
 * Check whether a request path is a public page (not builder, not internal).
 */
export function isPublicPage(pathname: string): boolean {
  return (
    !pathname.startsWith('/ycode') &&
    !pathname.startsWith('/_next') &&
    !pathname.startsWith('/api') &&
    !pathname.startsWith('/dynamic')
  );
}
