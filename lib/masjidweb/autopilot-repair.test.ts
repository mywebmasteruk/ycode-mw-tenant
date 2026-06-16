import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatAutopilotRepairMarkdown,
  runAutopilotRepair,
  type CommandResult,
  type RepairCommandRunner,
} from './autopilot-repair';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'autopilot-repair-'));
}

function makeRunner(conflictFiles: string[], commands: Record<string, CommandResult> = {}): RepairCommandRunner {
  return (command: string) => {
    if (command === 'git diff --name-only --diff-filter=U') {
      return { stdout: `${conflictFiles.join('\n')}\n`, exitCode: 0 };
    }
    if (command === 'git grep -l "^<<<<<<<" -- . ":(exclude)node_modules"') {
      return { stdout: '', exitCode: 1 };
    }
    return commands[command] ?? { stdout: '', exitCode: 0 };
  };
}

function conflict(...lines: string[]): string {
  return ['before', '<<<<<<< HEAD', ...lines, '=======', 'upstream', '>>>>>>> upstream/main', 'after'].join('\n');
}

function safePageFetcherContent(): string {
  return [
    "import { getSupabaseAdmin } from '@/lib/supabase-server';",
    "import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';",
    "import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';",
    'async function fetchPageByPathInternal() {',
    '  const supabase = await getSupabaseAdmin();',
    '  const tenantId = await resolveEffectiveTenantId();',
    "  let pagesQuery = supabase.from('pages').select('*').eq('is_published', true);",
    '  pagesQuery = applyTenantEq(pagesQuery, tenantId);',
    "  let layersQuery = supabase.from('page_layers').select('*').eq('page_id', 'page-1');",
    '  layersQuery = applyTenantEq(layersQuery, tenantId);',
    "  let itemsQuery = supabase.from('collection_items').select('*').eq('collection_id', 'collection-1');",
    '  itemsQuery = applyTenantEq(itemsQuery, tenantId);',
    '  return Promise.all([pagesQuery, layersQuery, itemsQuery]);',
    '}',
  ].join('\n');
}

function unsafePageFetcherContent(): string {
  return [
    "import { getSupabaseAdmin } from '@/lib/supabase-server';",
    'async function fetchPageByPathInternal() {',
    '  const supabase = await getSupabaseAdmin();',
    "  return supabase.from('pages').select('*').eq('id', 'page-1').single();",
    '}',
  ].join('\n');
}

function safeCollectionServiceContent(): string {
  return [
    "import { getSupabaseAdmin, getTenantIdFromHeaders } from '@/lib/supabase-server';",
    "import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';",
    "import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';",
    "import { getKnexClient } from '@/lib/knex-client';",
    'async function publishCollectionMetadata() {',
    '  const client = await getSupabaseAdmin();',
    '  const tenantId = await resolveEffectiveTenantId();',
    "  await client.from('collections').upsert({ id: 'collection-1', tenant_id: tenantId });",
    "  let fieldQuery = client.from('collection_fields').select('*').eq('collection_id', 'collection-1');",
    '  fieldQuery = applyTenantEq(fieldQuery, tenantId);',
    '  const knex = await getKnexClient();',
    '  const headerTenantId = await getTenantIdFromHeaders();',
    "  let query = knex('collection_items').where('is_published', false);",
    "  if (headerTenantId) query = query.where('tenant_id', headerTenantId);",
    '  return fieldQuery;',
    '}',
  ].join('\n');
}

function unsafeCollectionServiceContent(): string {
  return [
    "import { getSupabaseAdmin } from '@/lib/supabase-server';",
    'async function publishCollectionMetadata() {',
    '  const client = await getSupabaseAdmin();',
    "  return client.from('collection_items').select('*').in('id', ['item-1']);",
    '}',
  ].join('\n');
}

describe('autopilot-repair', () => {
  it('regenerates package-lock.json from package.json without touching package.json', () => {
    const repoRoot = makeRepo();
    const packageJson = '{"name":"demo","version":"1.0.0"}\n';
    writeFileSync(join(repoRoot, 'package.json'), packageJson);
    writeFileSync(join(repoRoot, 'package-lock.json'), conflict('lock'));

    const runner = makeRunner(['package-lock.json'], {
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps': {
        stdout: '',
        exitCode: 0,
      },
      'npm run updates:autopilot-guard': { stdout: 'guard ok', exitCode: 0 },
    });

    const report = runAutopilotRepair({ repoRoot, runCommand: runner });

    expect(report.status).toBe('success');
    expect(report.repairedFiles).toEqual(['package-lock.json']);
    expect(report.actions[0]?.strategy).toBe('npm-lockfile-only');
    expect(report.guard?.passed).toBe(true);
  });

  it('blocks package-lock repair if npm mutates package.json', () => {
    const repoRoot = makeRepo();
    const packageJsonPath = join(repoRoot, 'package.json');
    writeFileSync(packageJsonPath, '{"name":"demo","version":"1.0.0"}\n');
    writeFileSync(join(repoRoot, 'package-lock.json'), conflict('lock'));

    const runner = makeRunner(['package-lock.json'], {
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps': {
        stdout: '',
        exitCode: 0,
      },
    });
    const mutatingRunner: RepairCommandRunner = (command) => {
      const result = runner(command);
      if (command.startsWith('npm install')) {
        writeFileSync(packageJsonPath, '{"name":"demo","version":"2.0.0"}\n');
      }
      return result;
    };

    const report = runAutopilotRepair({ repoRoot, runCommand: mutatingRunner });

    expect(report.status).toBe('blocked');
    expect(report.blockedFiles).toEqual(['package-lock.json']);
    expect(report.actions[0]?.summary).toContain('package.json');
  });

  it('blocks high-risk repository conflicts when tenant invariants cannot be proven', () => {
    const repoRoot = makeRepo();
    const filePath = 'lib/repositories/collectionItemRepository.ts';
    const fullPath = join(repoRoot, 'lib/repositories');
    writeFileSync(join(repoRoot, 'package.json'), '{}\n');
    mkdirSync(fullPath, { recursive: true });
    writeFileSync(join(repoRoot, filePath), conflict('export async function getItems() { return []; }'));

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([filePath]),
      runGuard: false,
    });

    expect(report.status).toBe('blocked');
    expect(report.blockedFiles).toEqual([filePath]);
    expect(report.actions[0]?.strategy).toBe('fail-closed-tenant-seam');
    expect(report.actions[0]?.details.join('\n')).toContain('conflict markers');
    expect(report.actions[0]?.details.join('\n')).toContain('tenant resolver present');
  });

  it('blocks page-fetcher conflicts with exact tenant invariant reasons', () => {
    const repoRoot = makeRepo();
    const filePath = 'lib/page-fetcher.ts';
    mkdirSync(join(repoRoot, 'lib'), { recursive: true });
    writeFileSync(join(repoRoot, filePath), conflict(unsafePageFetcherContent()));

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([filePath]),
      runGuard: false,
    });

    expect(report.status).toBe('blocked');
    expect(report.blockedFiles).toEqual([filePath]);
    expect(report.actions[0]?.strategy).toBe('fail-closed-tenant-seam');
    expect(report.actions[0]?.reasonCategory).toBe('conflict-markers-remain');
    expect(report.actions[0]?.details.join('\n')).toContain('conflict markers');
    expect(report.actions[0]?.details.join('\n')).toContain('tenant resolver present');
    expect(report.actions[0]?.details.join('\n')).toContain('page reads tenant scoped');
  });

  it('accepts page-fetcher only when conflict markers are gone and tenant scope is provable', () => {
    const repoRoot = makeRepo();
    const filePath = 'lib/page-fetcher.ts';
    mkdirSync(join(repoRoot, 'lib'), { recursive: true });
    writeFileSync(join(repoRoot, filePath), safePageFetcherContent());

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([filePath]),
      runGuard: false,
    });

    expect(report.status).toBe('blocked');
    expect(report.actions[0]?.reasonCategory).toBe('known-resolver-unavailable');
    expect(report.actions[0]?.details.join('\n')).toContain('no registered deterministic v2.2 resolver');
  });

  it('blocks collectionService conflicts with exact tenant invariant reasons', () => {
    const repoRoot = makeRepo();
    const filePath = 'lib/services/collectionService.ts';
    mkdirSync(join(repoRoot, 'lib/services'), { recursive: true });
    writeFileSync(join(repoRoot, filePath), conflict(unsafeCollectionServiceContent()));

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([filePath]),
      runGuard: false,
    });

    expect(report.status).toBe('blocked');
    expect(report.blockedFiles).toEqual([filePath]);
    expect(report.actions[0]?.strategy).toBe('fail-closed-tenant-seam');
    expect(report.actions[0]?.reasonCategory).toBe('conflict-markers-remain');
    expect(report.actions[0]?.details.join('\n')).toContain('conflict markers');
    expect(report.actions[0]?.details.join('\n')).toContain('tenant resolver present');
    expect(report.actions[0]?.details.join('\n')).toContain('service-role table reads tenant scoped');
  });

  it('accepts collectionService only when conflict markers are gone and tenant scope is provable', () => {
    const repoRoot = makeRepo();
    const filePath = 'lib/services/collectionService.ts';
    mkdirSync(join(repoRoot, 'lib/services'), { recursive: true });
    writeFileSync(join(repoRoot, filePath), safeCollectionServiceContent());

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([filePath]),
      runGuard: false,
    });

    expect(report.status).toBe('blocked');
    expect(report.actions[0]?.reasonCategory).toBe('known-resolver-unavailable');
    expect(report.actions[0]?.details.join('\n')).toContain('no registered deterministic v2.2 resolver');
  });

  it('groups blocked files by reason with dashboard next actions', () => {
    const repoRoot = makeRepo();
    const pageFetcherPath = 'lib/page-fetcher.ts';
    const collectionServicePath = 'lib/services/collectionService.ts';
    mkdirSync(join(repoRoot, 'lib/services'), { recursive: true });
    writeFileSync(join(repoRoot, pageFetcherPath), conflict(unsafePageFetcherContent()));
    writeFileSync(join(repoRoot, collectionServicePath), safeCollectionServiceContent());

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([pageFetcherPath, collectionServicePath]),
      runGuard: false,
    });
    const markdown = formatAutopilotRepairMarkdown(report);

    expect(report.blockedByReason['conflict-markers-remain']).toEqual([pageFetcherPath]);
    expect(report.blockedByReason['known-resolver-unavailable']).toEqual([collectionServicePath]);
    expect(report.dashboardNextAction).toContain(pageFetcherPath);
    expect(markdown).toContain('Known resolver unavailable');
    expect(markdown).toContain('Conflict markers remain');
    expect(markdown).toContain('Dashboard next action');
  });

  it('does not group repaired files as blocked unknowns', () => {
    const repoRoot = makeRepo();
    writeFileSync(join(repoRoot, 'package.json'), '{"scripts":{}}');
    writeFileSync(join(repoRoot, 'package-lock.json'), conflict('{"lockfileVersion":3}'));

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner(['package-lock.json']),
      runGuard: false,
    });
    const markdown = formatAutopilotRepairMarkdown(report);

    expect(report.repairedFiles).toEqual(['package-lock.json']);
    expect(report.blockedByReason.unknown).toEqual([]);
    expect(markdown).not.toContain('### Unknown');
  });

  it('formats a human-readable report with actionable blocked details', () => {
    const repoRoot = makeRepo();
    const filePath = 'app/(builder)/ycode/api/publish/route.ts';
    mkdirSync(join(repoRoot, 'app/(builder)/ycode/api/publish'), { recursive: true });
    writeFileSync(join(repoRoot, filePath), conflict('export async function POST() {}'));

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([filePath]),
      runGuard: false,
    });
    const markdown = formatAutopilotRepairMarkdown(report);

    expect(markdown).toContain('# Core Update Autopilot v2.2 repair report');
    expect(markdown).toContain('Status: blocked');
    expect(markdown).toContain(filePath);
    expect(markdown).toContain('publish tenant resolver present');
    expect(markdown).toContain('developer');
  });
});
