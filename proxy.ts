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
  // MASJIDWEB_SEAM_END

  // Defense in depth: never trust client-supplied tenant headers
  request.headers.delete('x-tenant-id');
  request.headers.delete('x-tenant-slug');

  // MASJIDWEB_SEAM: subdomain-tenant-resolution — see docs/masjidweb-core-seams.md#subdomain
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
    // Builder on apex domain: derive tenant from JWT
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

  // Protect API and preview routes with auth + tenant / JWT alignment
  if (pathname.startsWith('/ycode/api') || pathname.startsWith('/ycode/preview')) {
    // MASJIDWEB_SEAM: auth-tenant-alignment — see docs/masjidweb-core-seams.md#auth-alignment
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

  const response = NextResponse.next({ request });

  response.headers.set('x-pathname', pathname);
  attachTenantNetlifyCacheTag(response, request, pathname);

  return response;
}

/**
 * Public HTML: shared caches must not store (`private`) so publish is visible immediately;
 * per-tenant Netlify-Cache-Tag so purgeCache({ tags }) only drops that tenant. Skip `/a/*`
 * (immutable hashed assets — next.config sets long public cache).
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
