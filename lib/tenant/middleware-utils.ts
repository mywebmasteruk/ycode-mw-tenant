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
