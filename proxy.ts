import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { User } from '@supabase/supabase-js';
import {
  requestHostname,
  supabaseCookieOptionsForRequestHeaders,
} from '@/lib/supabase-cookie-domain';
import { tenantJwtHeaderMismatchReason } from '@/lib/masjidweb/tenant-session-alignment';
import {
  extractSubdomain,
  getSupabaseEnvConfig,
  isPublicApiRoute,
  isPublicPage,
} from '@/lib/tenant';
import { lookupTenant } from '@/lib/tenant/tenant-registry-lookup';
import { tenantAllPagesTag } from '@/lib/masjidweb/tenant-cache-tags';
import {
  buildTenantRoutePath,
  isInternalTenantRoutePath,
  shouldRewriteToTenantRoute,
} from '@/lib/masjidweb/route-tenant-resolution';

const TENANT_DOMAIN_SUFFIX = process.env.TENANT_DOMAIN_SUFFIX || '';

/** Subdomain for the template / demo editor (default: manage). */
const MASTER_BUILDER_SUBDOMAIN = (
  process.env.MASTER_BUILDER_SUBDOMAIN || 'manage'
).toLowerCase();

type ApiAuthResult =
  | { kind: 'public' }
  | { kind: 'unauthenticated'; response: NextResponse }
  | { kind: 'authenticated'; user: User };

type CookieToSet = {
  name: string;
  value: string;
  options: CookieOptions;
};

/**
 * Verify Supabase session for protected API / preview routes.
 */
async function verifyApiAuth(request: NextRequest): Promise<ApiAuthResult> {
  if (isPublicApiRoute(request.nextUrl.pathname, request.method)) {
    return { kind: 'public' };
  }

  const config = getSupabaseEnvConfig();

  // If env vars aren't set (pre-setup or local dev without .env.local), let through
  if (!config) return { kind: 'public' };

  let response = NextResponse.next({ request });

  const cookieOpts = supabaseCookieOptionsForRequestHeaders(
    request.headers,
    undefined,
    config.url,
  );

  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
    ...(cookieOpts ? { cookieOptions: cookieOpts } : {}),
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      kind: 'unauthenticated',
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }

  return { kind: 'authenticated', user };
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = requestHostname(request.headers);

  // MCP endpoints use their own token-based authentication — skip session auth.
  // Cloud overlay proxies MUST also exempt these paths to avoid login redirects.
  //   - `/ycode/mcp/<token>`: legacy URL-token endpoint (Cursor, Windsurf, etc.)
  //   - `/ycode/mcp`: OAuth Bearer-token endpoint (Claude.ai web, ChatGPT)
  if (pathname === '/ycode/mcp' || pathname.startsWith('/ycode/mcp/')) {
    const response = NextResponse.next();
    response.headers.set('x-pathname', pathname);
    return response;
  }

  // MASJIDWEB_SEAM: route-based-tenant-resolution guard — see
  // lib/masjidweb/route-tenant-resolution.ts. Always on, independent of the
  // feature flag. The internal `/mw-tenant/<tenantId>/…` routes read the tenant
  // from the URL path, so they must only ever be reached via the internal
  // rewrite below (NextResponse.rewrite does not re-run middleware). Any request
  // arriving here with that prefix came directly from a client, which would let
  // it select an arbitrary tenant's published content by id — 404 it.
  if (isInternalTenantRoutePath(pathname)) {
    return new NextResponse('Not found', { status: 404 });
  }
  // MASJIDWEB_SEAM_END

  // MASJIDWEB_SEAM: provisioning-publish — see docs/masjidweb-core-seams.md#provisioning
  const provisioningSecret = process.env.PROVISIONING_WEBHOOK_SECRET;
  const isProvisionPublish =
    request.method === 'POST' &&
    pathname === '/ycode/api/publish' &&
    !!provisioningSecret &&
    request.headers.get('x-provisioning-secret') === provisioningSecret;

  const provisionTenantSlug = isProvisionPublish
    ? request.headers.get('x-tenant-slug')
    : null;

  // Defense in depth: never trust client-supplied tenant headers
  request.headers.delete('x-tenant-id');
  request.headers.delete('x-tenant-slug');

  const subdomain = extractSubdomain(host, TENANT_DOMAIN_SUFFIX);

  if (subdomain) {
    if (subdomain === MASTER_BUILDER_SUBDOMAIN) {
      const masterId = process.env.TEMPLATE_TENANT_ID?.trim();
      if (masterId) {
        request.headers.set('x-tenant-id', masterId);
        request.headers.set('x-tenant-slug', MASTER_BUILDER_SUBDOMAIN);
      } else {
        const tenant = await lookupTenant(subdomain, {
          bypassCache: isProvisionPublish,
        });
        if (!tenant) {
          return new NextResponse(
            'Master builder: set TEMPLATE_TENANT_ID (template tenant UUID) or add an active tenant_registry row for the demo slug (e.g. masjidemo1).',
            { status: 503 },
          );
        }
        request.headers.set('x-tenant-id', tenant.id);
        request.headers.set('x-tenant-slug', tenant.slug);
      }
    } else {
      const tenant = await lookupTenant(subdomain, {
        bypassCache: isProvisionPublish,
      });
      if (!tenant) {
        return new NextResponse('Tenant not found', { status: 404 });
      }
      request.headers.set('x-tenant-id', tenant.id);
      request.headers.set('x-tenant-slug', tenant.slug);
    }
  } else if (isProvisionPublish) {
    if (!provisionTenantSlug) {
      return NextResponse.json(
        { error: 'Provisioning publish requires X-Tenant-Slug' },
        { status: 400 },
      );
    }
    const tenant = await lookupTenant(provisionTenantSlug, {
      bypassCache: true,
    });
    if (!tenant) {
      return NextResponse.json(
        { error: `Tenant not found for slug: ${provisionTenantSlug}` },
        { status: 404 },
      );
    }
    request.headers.set('x-tenant-id', tenant.id);
    request.headers.set('x-tenant-slug', tenant.slug);
  } else if (pathname.startsWith('/ycode')) {
    const sbConfig = getSupabaseEnvConfig();
    if (sbConfig) {
      try {
        const apexCookieOpts = supabaseCookieOptionsForRequestHeaders(
          request.headers,
          undefined,
          sbConfig.url,
        );
        const supabase = createServerClient(sbConfig.url, sbConfig.anonKey, {
          cookies: {
            getAll() {
              return request.cookies.getAll();
            },
            setAll() {
              /* read-only in proxy */
            },
          },
          ...(apexCookieOpts ? { cookieOptions: apexCookieOpts } : {}),
        });
        const {
          data: { user },
        } = await supabase.auth.getUser();
        const tid = user?.app_metadata?.tenant_id || user?.user_metadata?.tenant_id;
        if (tid) {
          request.headers.set('x-tenant-id', String(tid));
          request.headers.set(
            'x-tenant-slug',
            String(user?.app_metadata?.tenant_slug || user?.user_metadata?.tenant_slug || ''),
          );
        }
      } catch {
        /* no session — unauthenticated visitor */
      }
    }
  }
  // MASJIDWEB_SEAM_END

  // Debug escape hatch: skip auth on preview routes when explicitly enabled.
  const skipPreviewAuth = process.env.DISABLE_PREVIEW_AUTH === 'true'
    && pathname.startsWith('/ycode/preview');

  // Protect API and preview routes with auth + tenant / JWT alignment
  if (!skipPreviewAuth && (pathname.startsWith('/ycode/api') || pathname.startsWith('/ycode/preview'))) {
    // MASJIDWEB_SEAM: tenant-jwt-alignment — see docs/masjidweb-core-seams.md#auth
    if (!isProvisionPublish) {
      const auth = await verifyApiAuth(request);
      if (auth.kind === 'unauthenticated') {
        if (pathname.startsWith('/ycode/preview')) {
          return NextResponse.redirect(new URL('/ycode', request.url));
        }
        return auth.response;
      }
      if (auth.kind === 'authenticated' && pathname.startsWith('/ycode/api')) {
        const headerTid = request.headers.get('x-tenant-id');
        if (tenantJwtHeaderMismatchReason(headerTid, auth.user)) {
          return NextResponse.json(
            { error: 'Tenant mismatch between session and site' },
            { status: 403 },
          );
        }
      }
    }
    // MASJIDWEB_SEAM_END
  }

  const hasPaginationParams = Array.from(request.nextUrl.searchParams.keys())
    .some((key) => key.startsWith('p_'));

  if (isPublicPage(pathname) && hasPaginationParams) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = pathname === '/' ? '/dynamic' : `/dynamic${pathname}`;

    const rewriteResponse = NextResponse.rewrite(rewriteUrl, { request });
    rewriteResponse.headers.set('x-pathname', pathname);
    attachTenantNetlifyCacheTag(rewriteResponse, request, pathname);
    return rewriteResponse;
  }

  // MASJIDWEB_SEAM: route-based-tenant-resolution rewrite — see
  // lib/masjidweb/route-tenant-resolution.ts. Flag-gated (default off). When
  // enabled for this host, rewrite the public page GET onto the internal
  // param-based route so it resolves tenant from the path (not headers()) and
  // becomes cacheable. Pagination requests already returned above and stay
  // dynamic. We attach the tenant purge tag but deliberately do NOT call
  // attachTenantNetlifyCacheTag (which would set `Cache-Control: private`,
  // forbidding the shared caching this whole path exists to enable).
  if (isPublicPage(pathname) && request.method === 'GET') {
    const rewriteTid = request.headers.get('x-tenant-id')?.trim();
    if (rewriteTid && shouldRewriteToTenantRoute(host)) {
      const tenantRouteUrl = request.nextUrl.clone();
      tenantRouteUrl.pathname = buildTenantRoutePath(rewriteTid, pathname);
      const tenantRouteResponse = NextResponse.rewrite(tenantRouteUrl, { request });
      tenantRouteResponse.headers.set('x-pathname', pathname);
      tenantRouteResponse.headers.set('Netlify-Cache-Tag', tenantAllPagesTag(rewriteTid));
      return tenantRouteResponse;
    }
  }
  // MASJIDWEB_SEAM_END

  const response = NextResponse.next({ request });

  response.headers.set('x-pathname', pathname);
  attachTenantNetlifyCacheTag(response, request, pathname);

  return response;
}

/**
 * Public HTML: `private, max-age=0, must-revalidate` — no shared cache (Netlify
 * Edge, Cloudflare) stores a response; every visit re-runs the dynamic SSR render.
 * 2026-07-01: briefly changed the shared-cache directive to `public ... s-maxage=60`
 * hoping middleware headers could make Netlify cache the route. Verified live this
 * had ZERO effect — Netlify's Next.js runtime decides cacheability from the route's
 * own build-time `dynamic`/`revalidate` export, evaluated before middleware ever
 * runs (see netlify/next-runtime#2350), so a header set here can't change it either
 * way. Reverted to the original directive since it no longer serves any purpose and
 * asserting shared-cacheability here was misleading. The Netlify-Cache-Tag below is
 * unaffected — it's inert unless something actually caches the response, but is
 * left in place for a future caching attempt. Skip `/a/*` (immutable hashed assets
 * — next.config sets long public cache).
 */
function attachTenantNetlifyCacheTag(
  response: NextResponse,
  request: NextRequest,
  pathname: string,
): void {
  if (!isPublicPage(pathname) || pathname.startsWith('/a/')) return;
  response.headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
  const tid = request.headers.get('x-tenant-id')?.trim();
  if (!tid) return;
  response.headers.set('Netlify-Cache-Tag', tenantAllPagesTag(tid));
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
