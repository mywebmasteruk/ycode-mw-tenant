import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestHostname,
  supabaseAuthCookieName,
  supabaseCookieOptionsForHost,
  supabaseCookieOptionsForRequestHeaders,
  tenantDomainSuffixFromEnv,
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
  it('derives the Supabase auth cookie name from the project ref', () => {
    expect(supabaseAuthCookieName(PROJECT_URL)).toBe('sb-abc123-auth-token');
  });
});

describe('supabaseCookieOptionsForHost', () => {
  it('sets a shared domain cookie for tenant subdomains', () => {
    expect(
      supabaseCookieOptionsForHost('tenant.masjidweb.com', 'masjidweb.com', PROJECT_URL),
    ).toEqual({ domain: '.masjidweb.com', name: 'sb-abc123-auth-token' });
  });

  it('sets a shared domain cookie for the apex host', () => {
    expect(
      supabaseCookieOptionsForHost('masjidweb.com', 'masjidweb.com', PROJECT_URL),
    ).toEqual({ domain: '.masjidweb.com', name: 'sb-abc123-auth-token' });
  });

  it('does not set shared domain cookies for localhost or dot-localhost hosts', () => {
    expect(
      supabaseCookieOptionsForHost('localhost', 'localhost', PROJECT_URL),
    ).toBeUndefined();
    expect(
      supabaseCookieOptionsForHost('tenant.localhost', 'localhost', PROJECT_URL),
    ).toBeUndefined();
  });

  it('keeps only the cookie name for unrelated hosts', () => {
    expect(
      supabaseCookieOptionsForHost('other.example', 'masjidweb.com', PROJECT_URL),
    ).toEqual({ name: 'sb-abc123-auth-token' });
  });

  it('returns undefined when no suffix is configured and no project URL is available', () => {
    expect(supabaseCookieOptionsForHost('tenant.masjidweb.com', undefined)).toBeUndefined();
  });
});

describe('supabaseCookieOptionsForRequestHeaders', () => {
  it('uses the request hostname when deriving cookie options', () => {
    const headers = new Headers({
      'x-forwarded-host': 'tenant.masjidweb.com:443, internal.local',
    });

    expect(
      supabaseCookieOptionsForRequestHeaders(headers, 'masjidweb.com', PROJECT_URL),
    ).toEqual({ domain: '.masjidweb.com', name: 'sb-abc123-auth-token' });
  });
});
