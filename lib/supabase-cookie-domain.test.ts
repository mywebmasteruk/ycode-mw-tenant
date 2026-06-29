import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestHostname,
  supabaseAuthCookieName,
  supabaseCookieOptionsForHost,
  supabaseCookieOptionsForRequestHeaders,
  tenantDomainSuffixFromEnv,
  tenantScopedAuthCookieName,
} from '@/lib/supabase-cookie-domain';

const PROJECT_URL = 'https://abc123.supabase.co';

describe('tenantDomainSuffixFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers TENANT_DOMAIN_SUFFIX and trims whitespace', () => {
    vi.stubEnv('TENANT_DOMAIN_SUFFIX', ' masjidweb.com ');
    vi.stubEnv('NEXT_PUBLIC_TENANT_DOMAIN_SUFFIX', 'public.example');

    expect(tenantDomainSuffixFromEnv()).toBe('masjidweb.com');
  });

  it('falls back to NEXT_PUBLIC_TENANT_DOMAIN_SUFFIX', () => {
    vi.stubEnv('TENANT_DOMAIN_SUFFIX', '');
    vi.stubEnv('NEXT_PUBLIC_TENANT_DOMAIN_SUFFIX', ' public.masjidweb.com ');

    expect(tenantDomainSuffixFromEnv()).toBe('public.masjidweb.com');
  });
});

describe('requestHostname', () => {
  it('prefers the first x-forwarded-host value and strips the port', () => {
    const headers = new Headers({
      'x-forwarded-host': 'tenant.masjidweb.com:443, internal.local:3000',
      host: 'fallback.masjidweb.com',
    });

    expect(requestHostname(headers)).toBe('tenant.masjidweb.com');
  });

  it('falls back to the Host header and strips the port', () => {
    const headers = new Headers({ host: 'tenant.masjidweb.com:3002' });

    expect(requestHostname(headers)).toBe('tenant.masjidweb.com');
  });

  it('returns an empty string when no host headers are present', () => {
    expect(requestHostname(new Headers())).toBe('');
  });
});

describe('supabaseAuthCookieName', () => {
  it('derives the legacy Supabase auth cookie name from the project ref', () => {
    expect(supabaseAuthCookieName(PROJECT_URL)).toBe('sb-abc123-auth-token');
  });
});

describe('tenantScopedAuthCookieName', () => {
  it('keys the cookie name on the full host so it is unique per subdomain', () => {
    expect(tenantScopedAuthCookieName(PROJECT_URL, 'tenant-a.masjidweb.com')).toBe(
      'sb-abc123-tenant-a-masjidweb-com-auth-token',
    );
    expect(tenantScopedAuthCookieName(PROJECT_URL, 'tenant-b.masjidweb.com')).toBe(
      'sb-abc123-tenant-b-masjidweb-com-auth-token',
    );
  });

  it('strips the port and never collides with the legacy shared cookie name', () => {
    const name = tenantScopedAuthCookieName(PROJECT_URL, 'tenant.masjidweb.com:443');
    expect(name).toBe('sb-abc123-tenant-masjidweb-com-auth-token');
    expect(name).not.toBe(supabaseAuthCookieName(PROJECT_URL));
  });
});

describe('supabaseCookieOptionsForHost', () => {
  it('returns a host-only (no domain) per-host cookie for tenant subdomains', () => {
    expect(
      supabaseCookieOptionsForHost('tenant-a.masjidweb.com', 'masjidweb.com', PROJECT_URL),
    ).toEqual({ name: 'sb-abc123-tenant-a-masjidweb-com-auth-token' });
  });

  it('gives different subdomains different cookie names so sessions stay independent', () => {
    const a = supabaseCookieOptionsForHost('tenant-a.masjidweb.com', 'masjidweb.com', PROJECT_URL);
    const b = supabaseCookieOptionsForHost('tenant-b.masjidweb.com', 'masjidweb.com', PROJECT_URL);
    expect(a).not.toEqual(b);
    expect(a?.domain).toBeUndefined();
    expect(b?.domain).toBeUndefined();
  });

  it('does not scope cookies for localhost or dot-localhost hosts', () => {
    expect(
      supabaseCookieOptionsForHost('localhost', 'localhost', PROJECT_URL),
    ).toBeUndefined();
    expect(
      supabaseCookieOptionsForHost('tenant.localhost', 'localhost', PROJECT_URL),
    ).toBeUndefined();
  });

  it('returns undefined when no project URL is available (cannot name the cookie)', () => {
    expect(supabaseCookieOptionsForHost('tenant.masjidweb.com', 'masjidweb.com')).toBeUndefined();
  });
});

describe('supabaseCookieOptionsForRequestHeaders', () => {
  it('uses the request hostname when deriving the per-host cookie name', () => {
    const headers = new Headers({
      'x-forwarded-host': 'tenant.masjidweb.com:443, internal.local',
    });

    expect(
      supabaseCookieOptionsForRequestHeaders(headers, 'masjidweb.com', PROJECT_URL),
    ).toEqual({ name: 'sb-abc123-tenant-masjidweb-com-auth-token' });
  });
});
