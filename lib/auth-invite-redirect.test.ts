import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { resolveInviteRedirectUrl } from '@/lib/auth-invite-redirect';

function requestWithHeaders(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as NextRequest;
}

describe('resolveInviteRedirectUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts an absolute redirect on the same host', () => {
    const request = requestWithHeaders({ host: 'tenant.masjidweb.com' });

    expect(
      resolveInviteRedirectUrl(
        request,
        'https://tenant.masjidweb.com/ycode/accept-invite',
      ),
    ).toBe('https://tenant.masjidweb.com/ycode/accept-invite');
  });

  it('accepts an absolute redirect on the configured tenant suffix', () => {
    vi.stubEnv('TENANT_DOMAIN_SUFFIX', 'masjidweb.com');
    const request = requestWithHeaders({ host: 'tenant.masjidweb.com' });

    expect(
      resolveInviteRedirectUrl(
        request,
        'https://another-tenant.masjidweb.com/ycode/accept-invite',
      ),
    ).toBe('https://another-tenant.masjidweb.com/ycode/accept-invite');
  });

  it('rejects a foreign absolute redirect and falls back to the request host', () => {
    vi.stubEnv('TENANT_DOMAIN_SUFFIX', 'masjidweb.com');
    const request = requestWithHeaders({ host: 'tenant.masjidweb.com' });

    expect(
      resolveInviteRedirectUrl(request, 'https://evil.example/ycode/accept-invite'),
    ).toBe('https://tenant.masjidweb.com/ycode/accept-invite');
  });

  it('falls back to the request host for malformed, relative, or missing redirect input', () => {
    const request = requestWithHeaders({ host: 'tenant.masjidweb.com' });

    expect(resolveInviteRedirectUrl(request, 'not a url')).toBe(
      'https://tenant.masjidweb.com/ycode/accept-invite',
    );
    expect(resolveInviteRedirectUrl(request, '/ycode/accept-invite')).toBe(
      'https://tenant.masjidweb.com/ycode/accept-invite',
    );
    expect(resolveInviteRedirectUrl(request, undefined)).toBe(
      'https://tenant.masjidweb.com/ycode/accept-invite',
    );
  });

  it('uses forwarded proto and first forwarded host when deriving fallback URLs', () => {
    const request = requestWithHeaders({
      'x-forwarded-host': 'tenant.masjidweb.com, internal.local',
      'x-forwarded-proto': 'https, http',
      host: 'fallback.masjidweb.com',
    });

    expect(resolveInviteRedirectUrl(request, undefined)).toBe(
      'https://tenant.masjidweb.com/ycode/accept-invite',
    );
  });

  it('uses http for localhost fallback URLs', () => {
    const request = requestWithHeaders({ host: 'localhost:3002' });

    expect(resolveInviteRedirectUrl(request, undefined)).toBe(
      'http://localhost/ycode/accept-invite',
    );
  });

  it('returns undefined when no request host is available', () => {
    const request = requestWithHeaders({});

    expect(resolveInviteRedirectUrl(request, undefined)).toBeUndefined();
  });
});
