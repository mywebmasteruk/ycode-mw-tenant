import { describe, expect, it } from 'vitest';
import { takeTheirs } from './run-tenant-codemod-resolver';
import { reapplyTenantScoping } from '../../lib/masjidweb/tenant-scope-codemod';
import { analyzeTenantIsolation } from '../../lib/masjidweb/tenant-isolation-gate';

describe('takeTheirs', () => {
  it('keeps the upstream (theirs) side of a 2-way conflict', () => {
    const c = ['a', '<<<<<<< ours', 'OURS', '=======', 'THEIRS', '>>>>>>> upstream', 'b'].join('\n');
    expect(takeTheirs(c)).toBe(['a', 'THEIRS', 'b'].join('\n'));
  });

  it('handles diff3 markers (skips the base section)', () => {
    const c = [
      'x',
      '<<<<<<< ours',
      'OURS',
      '||||||| base',
      'BASE',
      '=======',
      'THEIRS',
      '>>>>>>> upstream',
      'y',
    ].join('\n');
    expect(takeTheirs(c)).toBe(['x', 'THEIRS', 'y'].join('\n'));
  });

  it('returns null on a malformed (unterminated) conflict', () => {
    expect(takeTheirs('<<<<<<< ours\nfoo\n=======\nbar')).toBeNull();
  });

  it('passes content through unchanged when there are no markers', () => {
    expect(takeTheirs('const x = 1;\n')).toBe('const x = 1;\n');
  });
});

describe('resolver integration: conflict → take-theirs → codemod → gate', () => {
  it('produces upstream logic + re-applied tenant scoping that passes the gate', () => {
    // OURS keeps tenant scoping; THEIRS is upstream's restructured unscoped query.
    const conflicted = [
      "export async function listPages(client) {",
      '<<<<<<< ours',
      '  const tenantId = await resolveEffectiveTenantId();',
      "  let query = client.from('pages').select('*').order('name');",
      '  query = applyTenantEq(query, tenantId);',
      '  const { data } = await query;',
      '=======',
      "  let query = client.from('pages').select('*').order('name').eq('is_published', true);",
      '  const { data } = await query;',
      '>>>>>>> upstream',
      '  return data;',
      '}',
    ].join('\n');

    const upstream = takeTheirs(conflicted);
    expect(upstream).not.toBeNull();
    expect(upstream).not.toContain('<<<<<<<');

    const { code, residual } = reapplyTenantScoping(upstream as string, 'lib/repositories/pageRepository.ts');

    // Upstream's new filter is preserved AND tenant scoping is re-applied.
    expect(code).toContain(".eq('is_published', true)");
    expect(code).toContain('query = applyTenantEq(query, tenantId);');
    expect(residual).toHaveLength(0);
    expect(analyzeTenantIsolation('lib/repositories/pageRepository.ts', code)).toEqual([]);
  });
});
