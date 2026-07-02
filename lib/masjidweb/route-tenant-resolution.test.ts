import { describe, expect, it } from 'vitest';
import {
  routeTenantResolutionMode,
  shouldRewriteToTenantRoute,
  isInternalTenantRoutePath,
  buildTenantRoutePath,
  TENANT_ROUTE_PREFIX,
} from './route-tenant-resolution';

const CANARY_HOST = 'high900.masjidweb.com';

describe('routeTenantResolutionMode', () => {
  it('defaults to off when unset (reversibility: no env = no change)', () => {
    expect(routeTenantResolutionMode({})).toBe('off');
  });

  it('reads canary and on', () => {
    expect(routeTenantResolutionMode({ MW_ROUTE_TENANT_RESOLUTION: 'canary' })).toBe('canary');
    expect(routeTenantResolutionMode({ MW_ROUTE_TENANT_RESOLUTION: 'on' })).toBe('on');
  });

  it('is case-insensitive and trims', () => {
    expect(routeTenantResolutionMode({ MW_ROUTE_TENANT_RESOLUTION: '  ON  ' })).toBe('on');
    expect(routeTenantResolutionMode({ MW_ROUTE_TENANT_RESOLUTION: 'Canary' })).toBe('canary');
  });

  it('falls back to off for any unrecognised value (fail safe)', () => {
    expect(routeTenantResolutionMode({ MW_ROUTE_TENANT_RESOLUTION: 'yes' })).toBe('off');
    expect(routeTenantResolutionMode({ MW_ROUTE_TENANT_RESOLUTION: 'true' })).toBe('off');
    expect(routeTenantResolutionMode({ MW_ROUTE_TENANT_RESOLUTION: '' })).toBe('off');
  });
});

describe('shouldRewriteToTenantRoute', () => {
  it('never rewrites when off (the default)', () => {
    expect(shouldRewriteToTenantRoute(CANARY_HOST, {})).toBe(false);
    expect(shouldRewriteToTenantRoute(CANARY_HOST, { MW_ROUTE_TENANT_CANARY_HOSTS: CANARY_HOST })).toBe(false);
  });

  it('canary rewrites only the listed host(s)', () => {
    const env = { MW_ROUTE_TENANT_RESOLUTION: 'canary', MW_ROUTE_TENANT_CANARY_HOSTS: CANARY_HOST };
    expect(shouldRewriteToTenantRoute(CANARY_HOST, env)).toBe(true);
    expect(shouldRewriteToTenantRoute('other.masjidweb.com', env)).toBe(false);
  });

  it('canary matches host case-insensitively and ignores the port', () => {
    const env = { MW_ROUTE_TENANT_RESOLUTION: 'canary', MW_ROUTE_TENANT_CANARY_HOSTS: CANARY_HOST };
    expect(shouldRewriteToTenantRoute('HIGH900.masjidweb.com', env)).toBe(true);
    expect(shouldRewriteToTenantRoute('high900.masjidweb.com:443', env)).toBe(true);
  });

  it('canary supports a comma-separated allowlist with stray whitespace', () => {
    const env = {
      MW_ROUTE_TENANT_RESOLUTION: 'canary',
      MW_ROUTE_TENANT_CANARY_HOSTS: ' a.masjidweb.com , b.masjidweb.com ',
    };
    expect(shouldRewriteToTenantRoute('a.masjidweb.com', env)).toBe(true);
    expect(shouldRewriteToTenantRoute('b.masjidweb.com', env)).toBe(true);
    expect(shouldRewriteToTenantRoute('c.masjidweb.com', env)).toBe(false);
  });

  it('canary with no allowlist rewrites nothing', () => {
    expect(shouldRewriteToTenantRoute(CANARY_HOST, { MW_ROUTE_TENANT_RESOLUTION: 'canary' })).toBe(false);
  });

  it('on rewrites every host', () => {
    const env = { MW_ROUTE_TENANT_RESOLUTION: 'on' };
    expect(shouldRewriteToTenantRoute(CANARY_HOST, env)).toBe(true);
    expect(shouldRewriteToTenantRoute('anything.example.com', env)).toBe(true);
  });
});

describe('isInternalTenantRoutePath', () => {
  it('matches the prefix exactly and as a parent', () => {
    expect(isInternalTenantRoutePath(TENANT_ROUTE_PREFIX)).toBe(true);
    expect(isInternalTenantRoutePath('/mw-tenant/abc')).toBe(true);
    expect(isInternalTenantRoutePath('/mw-tenant/abc/blog/post')).toBe(true);
  });

  it('does not false-match lookalike paths', () => {
    expect(isInternalTenantRoutePath('/mw-tenants')).toBe(false);
    expect(isInternalTenantRoutePath('/mw-tenant-x')).toBe(false);
    expect(isInternalTenantRoutePath('/about')).toBe(false);
    expect(isInternalTenantRoutePath('/')).toBe(false);
  });
});

describe('buildTenantRoutePath', () => {
  it('maps the homepage to a bare tenant path', () => {
    expect(buildTenantRoutePath('TID', '/')).toBe('/mw-tenant/TID');
  });

  it('preserves the original path verbatim as the slug segment(s)', () => {
    expect(buildTenantRoutePath('TID', '/about')).toBe('/mw-tenant/TID/about');
    expect(buildTenantRoutePath('TID', '/blog/post-1')).toBe('/mw-tenant/TID/blog/post-1');
  });

  it('keeps a locale-prefixed path intact', () => {
    expect(buildTenantRoutePath('TID', '/fr/a-propos')).toBe('/mw-tenant/TID/fr/a-propos');
  });
});
