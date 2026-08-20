import { describe, expect, it } from 'vitest';
import { healUndeclaredTenantId, parseTypecheckTenantIdFiles } from './heal-typecheck-tenant-id';

describe('parseTypecheckTenantIdFiles', () => {
  it('collects files with undeclared tenantId TS2304 errors', () => {
    const out = [
      "lib/repositories/collectionItemValueRepository.ts(85,9): error TS2304: Cannot find name 'tenantId'.",
      "lib/repositories/collectionItemValueRepository.ts(85,33): error TS2304: Cannot find name 'tenantId'.",
      'lib/other.ts(10,1): error TS2322: Type string is not assignable to type number.',
      "proxy.ts(12,4): error TS2304: Cannot find name 'effectiveTenantId'.",
    ].join('\n');
    expect(parseTypecheckTenantIdFiles(out)).toEqual([
      'lib/repositories/collectionItemValueRepository.ts',
      'proxy.ts',
    ]);
  });
});

describe('healUndeclaredTenantId', () => {
  it('inserts const tenantId and the effective-tenant-id import', () => {
    const source = `export async function insertValuesBulk(values: Array<{ value: string }>) {
  const valuesToInsert = values.map(v => ({
    value: v.value,
    ...(tenantId ? { tenant_id: tenantId } : {}),
  }));
  return valuesToInsert;
}
`;
    const { code, changed, inserts } = healUndeclaredTenantId(source);
    expect(changed).toBe(true);
    expect(inserts).toBe(1);
    expect(code).toContain("import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';");
    expect(code).toContain('const tenantId = await resolveEffectiveTenantId();');
    expect(code.indexOf('const tenantId')).toBeLessThan(code.indexOf('...(tenantId'));
  });

  it('is a no-op when tenantId is already declared', () => {
    const source = `import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
export async function insertValuesBulk() {
  const tenantId = await resolveEffectiveTenantId();
  return tenantId ? { tenant_id: tenantId } : {};
}
`;
    const { changed, code } = healUndeclaredTenantId(source);
    expect(changed).toBe(false);
    expect(code).toBe(source);
  });

  it('does not treat a nested function declaration as covering the outer function', () => {
    const source = `export async function insertValuesBulk() {
  async function stamp() {
    const tenantId = await resolveEffectiveTenantId();
    return tenantId;
  }
  return { ...(tenantId ? { tenant_id: tenantId } : {}) };
}
`;
    const { code, changed } = healUndeclaredTenantId(source);
    expect(changed).toBe(true);
    expect(code).toMatch(
      /export async function insertValuesBulk\(\) \{\s*const tenantId = await resolveEffectiveTenantId\(\);/,
    );
  });
});
