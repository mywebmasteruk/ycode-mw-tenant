import { describe, it, expect } from 'vitest';
import {
  extractSubdomain,
  isPublicApiRoute,
  isPublicPage,
} from './middleware-utils';

describe('extractSubdomain', () => {
  const SUFFIX = 'masjidweb.com';

  it('extracts a valid tenant subdomain', () => {
    expect(extractSubdomain('demo.masjidweb.com', SUFFIX)).toBe('demo');
  });

  it('handles uppercase and port', () => {
    expect(extractSubdomain('Demo.MasjidWeb.COM:3000', SUFFIX)).toBe('demo');
  });

  it('returns null for apex domain', () => {
    expect(extractSubdomain('masjidweb.com', SUFFIX)).toBeNull();
  });

  it('returns null for reserved subdomains', () => {
    expect(extractSubdomain('www.masjidweb.com', SUFFIX)).toBeNull();
    expect(extractSubdomain('admin.masjidweb.com', SUFFIX)).toBeNull();
    expect(extractSubdomain('api.masjidweb.com', SUFFIX)).toBeNull();
    expect(extractSubdomain('mail.masjidweb.com', SUFFIX)).toBeNull();
    expect(extractSubdomain('ftp.masjidweb.com', SUFFIX)).toBeNull();
    expect(extractSubdomain('tenants.masjidweb.com', SUFFIX)).toBeNull();
  });

  it('returns null for nested subdomains', () => {
    expect(extractSubdomain('a.b.masjidweb.com', SUFFIX)).toBeNull();
  });

  it('returns null for unrelated domain', () => {
    expect(extractSubdomain('demo.otherdomain.com', SUFFIX)).toBeNull();
  });

  it('returns null when suffix is empty', () => {
    expect(extractSubdomain('demo.masjidweb.com', '')).toBeNull();
  });

  it('returns manage subdomain (not reserved)', () => {
    expect(extractSubdomain('manage.masjidweb.com', SUFFIX)).toBe('manage');
  });
});

describe('isPublicApiRoute', () => {
  it('allows setup routes', () => {
    expect(isPublicApiRoute('/ycode/api/setup/status', 'GET')).toBe(true);
  });

  it('allows supabase config routes', () => {
    expect(isPublicApiRoute('/ycode/api/supabase/config', 'GET')).toBe(true);
  });

  it('allows auth bootstrap routes', () => {
    expect(isPublicApiRoute('/ycode/api/auth/session', 'GET')).toBe(true);
    expect(isPublicApiRoute('/ycode/api/auth/session', 'POST')).toBe(true);
    expect(isPublicApiRoute('/ycode/api/auth/callback', 'GET')).toBe(true);
    expect(isPublicApiRoute('/ycode/api/auth/callback', 'POST')).toBe(true);
  });

  it('keeps sensitive auth management routes protected', () => {
    expect(isPublicApiRoute('/ycode/api/auth/users', 'GET')).toBe(false);
    expect(isPublicApiRoute('/ycode/api/auth/users', 'DELETE')).toBe(false);
    expect(isPublicApiRoute('/ycode/api/auth/invite', 'POST')).toBe(false);
  });

  it('allows v1 public API before route-level API key validation', () => {
    expect(isPublicApiRoute('/ycode/api/v1/pages', 'GET')).toBe(true);
    expect(isPublicApiRoute('/ycode/api/v1/collections', 'POST')).toBe(true);
    expect(isPublicApiRoute('/ycode/api/v1/forms/form-1/submissions', 'POST')).toBe(true);
  });

  it('allows revalidate', () => {
    expect(isPublicApiRoute('/ycode/api/revalidate', 'POST')).toBe(true);
  });

  it('allows POST form-submissions', () => {
    expect(isPublicApiRoute('/ycode/api/form-submissions', 'POST')).toBe(true);
  });

  it('blocks GET form-submissions', () => {
    expect(isPublicApiRoute('/ycode/api/form-submissions', 'GET')).toBe(false);
  });

  it('allows POST to collection items filter', () => {
    expect(
      isPublicApiRoute('/ycode/api/collections/abc123/items/filter', 'POST'),
    ).toBe(true);
  });

  it('allows POST to collection items load-more', () => {
    expect(
      isPublicApiRoute(
        '/ycode/api/collections/abc123/items/load-more',
        'POST',
      ),
    ).toBe(true);
  });

  it('blocks GET to collection items filter', () => {
    expect(
      isPublicApiRoute('/ycode/api/collections/abc123/items/filter', 'GET'),
    ).toBe(false);
  });

  it('blocks protected builder API routes', () => {
    expect(isPublicApiRoute('/ycode/api/pages', 'GET')).toBe(false);
    expect(isPublicApiRoute('/ycode/api/layers', 'PUT')).toBe(false);
    expect(isPublicApiRoute('/ycode/api/publish', 'POST')).toBe(false);
    expect(isPublicApiRoute('/ycode/api/collections', 'GET')).toBe(false);
  });

  it('allows OAuth DCR register (called by unauthenticated MCP clients)', () => {
    expect(isPublicApiRoute('/ycode/api/oauth/register', 'POST')).toBe(true);
  });

  it('allows OAuth token exchange (called by unauthenticated MCP clients)', () => {
    expect(isPublicApiRoute('/ycode/api/oauth/token', 'POST')).toBe(true);
  });

  it('keeps OAuth authorize protected (requires user session)', () => {
    expect(isPublicApiRoute('/ycode/api/oauth/authorize', 'POST')).toBe(false);
  });
});

describe('isPublicPage', () => {
  it('identifies root as public', () => {
    expect(isPublicPage('/')).toBe(true);
  });

  it('identifies tenant pages as public', () => {
    expect(isPublicPage('/about')).toBe(true);
    expect(isPublicPage('/services/web-design')).toBe(true);
  });

  it('marks /ycode paths as non-public', () => {
    expect(isPublicPage('/ycode')).toBe(false);
    expect(isPublicPage('/ycode/api/pages')).toBe(false);
  });

  it('marks /_next paths as non-public', () => {
    expect(isPublicPage('/_next/data/abc.json')).toBe(false);
  });

  it('marks /api paths as non-public', () => {
    expect(isPublicPage('/api/health')).toBe(false);
  });

  it('marks /dynamic paths as non-public', () => {
    expect(isPublicPage('/dynamic/about')).toBe(false);
  });
});
