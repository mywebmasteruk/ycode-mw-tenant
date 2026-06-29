/**
 * MASJIDWEB_SEAM: per-tenant-auth-cookie — see docs/masjidweb-core-seams.md#tier-1
 *
 * Auth-cookie scoping for the multi-tenant builder.
 *
 * All tenants share ONE Supabase project, so the auth cookie name is the same
 * everywhere (`sb-<ref>-auth-token`). Previously we also set `domain=.masjidweb.com`
 * so the apex host could read a subdomain session — but that made every tenant
 * subdomain share a SINGLE cookie. Opening two tenant builders and logging into one
 * overwrote (logged out) the other. There is one cookie slot per (name, domain), so
 * independent simultaneous sessions are impossible with a shared name + shared domain.
 *
 * Fix: **host-only, per-host** auth cookies. Each tenant subdomain gets its own cookie
 * (`tenantScopedAuthCookieName`), so sessions are fully independent. The host-derived
 * name also guarantees the new cookie never collides with the legacy shared
 * `sb-<ref>-auth-token` cookie, so no migration cleanup is needed (the old cookie is
 * simply orphaned and expires; users re-log-in once).
 *
 * Trade-off: the apex `/ycode` "detect my tenant from the session" convenience no
 * longer works (apex can't read a subdomain's host-only cookie). Login already happens
 * on the tenant subdomain, so this only affects the apex landing shortcut.
 *
 * Important: every @supabase/ssr client that reads or writes auth cookies (browser,
 * OAuth callback, session route, proxy auth check, getAuthUser) MUST pass `projectUrl`
 * so they all compute the same per-host cookie name — otherwise reads and writes
 * disagree and the session breaks.
 *
 * `TENANT_DOMAIN_SUFFIX` / `NEXT_PUBLIC_TENANT_DOMAIN_SUFFIX` are still read (subdomain
 * extraction, invite-redirect host allow-list) but no longer drive the cookie domain.
 */
export function tenantDomainSuffixFromEnv(): string | undefined {
  const s =
    process.env.TENANT_DOMAIN_SUFFIX?.trim() ||
    process.env.NEXT_PUBLIC_TENANT_DOMAIN_SUFFIX?.trim();
  return s || undefined;
}

/** First host from x-forwarded-host or Host (Netlify / reverse proxies). */
export function requestHostname(headers: Headers): string {
  const xf = headers.get('x-forwarded-host');
  if (xf) {
    const first = xf.split(',')[0]?.trim() ?? '';
    if (first) return first.replace(/:\d+$/, '');
  }
  const host = headers.get('host')?.trim() ?? '';
  return host.replace(/:\d+$/, '');
}

export type SupabaseCookieOptions = {
  domain?: string;
  name?: string;
};

/** Supabase project ref from the project URL (`https://<ref>.supabase.co`). */
function supabaseProjectRef(projectUrl: string): string {
  return new URL(projectUrl).hostname.split('.')[0];
}

/** Legacy single-slot auth cookie name (`sb-<ref>-auth-token`). Kept for reference/tests. */
export function supabaseAuthCookieName(projectUrl: string): string {
  return `sb-${supabaseProjectRef(projectUrl)}-auth-token`;
}

/**
 * Per-host auth cookie name, e.g. `sb-<ref>-tenant-a-masjidweb-com-auth-token`.
 * Keying the name on the full host keeps each tenant subdomain's session separate
 * and ensures it can never collide with the legacy shared `sb-<ref>-auth-token`
 * cookie. Client (`window.location.hostname`) and server (`requestHostname`) both
 * resolve to the same public host, so they agree on the name.
 */
export function tenantScopedAuthCookieName(projectUrl: string, hostname: string): string {
  const host = hostname.replace(/:\d+$/, '').toLowerCase();
  const label = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
  return `sb-${supabaseProjectRef(projectUrl)}-${label}-auth-token`;
}

/**
 * Host-only, per-host cookie options. Intentionally returns **no `domain`** so the
 * auth cookie is scoped to the exact host — see the file header for why a shared
 * domain broke simultaneous multi-tenant sessions. `tenantDomainSuffix` is accepted
 * for signature compatibility but no longer influences cookie scope.
 */
export function supabaseCookieOptionsForHost(
  hostname: string,
  tenantDomainSuffix: string | undefined,
  projectUrl?: string,
): SupabaseCookieOptions | undefined {
  const h = hostname.replace(/:\d+$/, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return undefined;
  if (!projectUrl) return undefined;

  return { name: tenantScopedAuthCookieName(projectUrl, h) };
}

/** Cookie options for SSR / Edge clients when tenant suffix env is set and host matches. */
export function supabaseCookieOptionsForRequestHeaders(
  headers: Headers,
  tenantDomainSuffix: string | undefined = tenantDomainSuffixFromEnv(),
  projectUrl?: string,
): SupabaseCookieOptions | undefined {
  return supabaseCookieOptionsForHost(
    requestHostname(headers),
    tenantDomainSuffix,
    projectUrl,
  );
}
