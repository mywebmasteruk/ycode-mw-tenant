import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { reapplyTenantScoping } from './tenant-scope-codemod';
import { analyzeTenantIsolation } from './tenant-isolation-gate';

/** True if the source parses with no syntax errors (catches bad text splicing). */
function isSyntacticallyValid(code: string): boolean {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
  // @ts-expect-error parseDiagnostics is internal but reliable for syntax checks
  return (sf.parseDiagnostics?.length ?? 0) === 0;
}

describe('reapplyTenantScoping — synthetic forms', () => {
  it('adds applyTenantEq + tenantId + imports to an assigned read', () => {
    const upstream = `export async function getSettings(client) {
  let query = client.from('settings').select('*').order('key');
  const { data } = await query;
  return data;
}`;
    const { code, changes } = reapplyTenantScoping(upstream);
    expect(code).toMatch(/query = applyTenantEq\(query, tenantId\);/);
    expect(code).toMatch(/const tenantId = await resolveEffectiveTenantId\(\);/);
    expect(code).toMatch(/import \{ applyTenantEq \}/);
    expect(changes.length).toBeGreaterThan(0);
    expect(analyzeTenantIsolation('settingsRepository.ts', code)).toEqual([]);
    expect(isSyntacticallyValid(code)).toBe(true);
  });

  it('flips const→let so the read can be reassigned', () => {
    const upstream = `export async function f(client) {
  const query = client.from('pages').select('*');
  return await query;
}`;
    const { code } = reapplyTenantScoping(upstream);
    expect(code).toMatch(/let query = client\.from\('pages'\)/);
    expect(code).toMatch(/query = applyTenantEq\(query, tenantId\);/);
    expect(analyzeTenantIsolation('pageRepository.ts', code)).toEqual([]);
    expect(isSyntacticallyValid(code)).toBe(true);
  });

  it('adds tenant_id to an object-literal write payload', () => {
    const upstream = `export async function save(client, key, value) {
  return client.from('settings').upsert({ key, value }, { onConflict: 'key' });
}`;
    const { code } = reapplyTenantScoping(upstream);
    expect(code).toMatch(/tenant_id: tenantId/);
    expect(analyzeTenantIsolation('settingsRepository.ts', code)).toEqual([]);
    expect(isSyntacticallyValid(code)).toBe(true);
  });

  it('reuses an existing tenantId variable instead of inserting a duplicate', () => {
    const upstream = `import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
export async function f(client) {
  const tenantId = await resolveEffectiveTenantId();
  let query = client.from('assets').select('*');
  return await query;
}`;
    const { code } = reapplyTenantScoping(upstream);
    expect(code.match(/const tenantId = await resolveEffectiveTenantId/g)?.length).toBe(1);
    expect(analyzeTenantIsolation('assetRepository.ts', code)).toEqual([]);
  });

  it('is idempotent: re-running on already-scoped output is a no-op', () => {
    const upstream = `export async function f(client) {
  let query = client.from('pages').select('*');
  return await query;
}`;
    const once = reapplyTenantScoping(upstream).code;
    const twice = reapplyTenantScoping(once);
    expect(twice.code).toBe(once);
    expect(twice.changes).toEqual([]);
  });

  it('leaves an already-scoped query untouched (no double applyTenantEq)', () => {
    const scoped = `import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';
export async function f(client, tenantId) {
  let query = client.from('pages').select('*');
  query = applyTenantEq(query, tenantId);
  return await query;
}`;
    const { code, changes } = reapplyTenantScoping(scoped);
    expect(changes).toEqual([]);
    expect(code.match(/applyTenantEq\(query/g)?.length).toBe(1);
  });

  it('scopes a directly-awaited destructured read by wrapping the chain inline', () => {
    const upstream = `export async function f(client) {
  const { data } = await client.from('pages').select('*');
  return data;
}`;
    const { code, residual } = reapplyTenantScoping(upstream);
    expect(residual).toHaveLength(0);
    expect(code).toContain('const tenantId = await resolveEffectiveTenantId();');
    expect(code).toContain("applyTenantEq(client.from('pages').select('*'), tenantId)");
  });

  it('wraps the filter builder, not the .single() result, for awaited single-row reads', () => {
    const upstream = `export async function f(client, id) {
  const { data } = await client.from('pages').select('*').eq('id', id).single();
  return data;
}`;
    const { code, residual } = reapplyTenantScoping(upstream);
    expect(residual).toHaveLength(0);
    // applyTenantEq must wrap the chain up to (not including) .single().
    expect(code).toContain(", tenantId).single()");
    expect(code).not.toContain('.single(), tenantId)');
  });

  it('still reports residual for an unscoped read that is neither assigned nor awaited', () => {
    const upstream = `export function build(client) {
  return client.from('pages').select('*');
}`;
    const { residual } = reapplyTenantScoping(upstream);
    expect(residual).toHaveLength(1);
    expect(residual[0]).toMatchObject({ table: 'pages' });
  });
});

describe('reapplyTenantScoping — real settingsRepository round-trip', () => {
  const repoRoot = join(__dirname, '..', '..');
  const original = readFileSync(join(repoRoot, 'lib/repositories/settingsRepository.ts'), 'utf8');

  /** Simulate the upstream (un-scoped) version by removing the fork's tenant seams. */
  function stripTenantScoping(src: string): string {
    return src
      .split('\n')
      .filter(
        (l) =>
          !/=\s*applyTenantEq\(/.test(l) &&
          !/const tenantId = await resolveEffectiveTenantId\(\);/.test(l) &&
          !/from '@\/lib\/masjidweb\/effective-tenant-id'/.test(l) &&
          !/from '@\/lib\/masjidweb\/apply-tenant-eq'/.test(l) &&
          !/\.\.\.\(tenantId \? \{ tenant_id: tenantId \} : \{\}\)/.test(l),
      )
      .join('\n');
  }

  it('strip → codemod restores scoping so the gate passes again', () => {
    const baseline = analyzeTenantIsolation('settingsRepository.ts', original);
    const stripped = stripTenantScoping(original);
    const strippedFindings = analyzeTenantIsolation('settingsRepository.ts', stripped);
    // Stripping must actually break isolation (sanity: the simulation is real).
    expect(strippedFindings.length).toBeGreaterThan(baseline.length);

    const { code } = reapplyTenantScoping(stripped, 'settingsRepository.ts');
    const restoredFindings = analyzeTenantIsolation('settingsRepository.ts', code);

    // The codemod re-applied scoping: no finding beyond whatever the original had.
    expect(restoredFindings.length).toBeLessThanOrEqual(baseline.length);
    expect(isSyntacticallyValid(code)).toBe(true);
  });
});
