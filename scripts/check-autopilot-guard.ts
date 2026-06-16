import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  classifyUpdateRisk,
  formatUpdateSafetyReport,
  type UpdateSafetyResult,
} from '../lib/masjidweb/update-safety-check';

interface InvariantCheck {
  filePath: string;
  name: string;
  ok: boolean;
  message: string;
}

const TENANT_GUARD_FILES = [
  'app/(builder)/ycode/api/publish/route.ts',
  'lib/repositories/collectionItemRepository.ts',
  'lib/repositories/collectionItemValueRepository.ts',
  'lib/repositories/pageRepository.ts',
  'lib/repositories/collectionFieldRepository.ts',
  'proxy.ts',
  'lib/supabase-cookie-domain.ts',
  'lib/supabase-browser.ts',
  'lib/supabase-route-client.ts',
];

function listAllowFailure(command: string): string[] {
  try {
    return execSync(command, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasConflictMarkers(content: string): boolean {
  return /^<<<<<<<|^=======|^>>>>>>>|^\|\|\|\|\|\|\|/m.test(content);
}

function includesAny(content: string, patterns: string[]): boolean {
  return patterns.some((pattern) => content.includes(pattern));
}

function checkContains(filePath: string, content: string, name: string, patterns: string[], message: string): InvariantCheck {
  return {
    filePath,
    name,
    ok: includesAny(content, patterns),
    message,
  };
}

function checkNoPattern(filePath: string, content: string, name: string, pattern: RegExp, message: string): InvariantCheck {
  return {
    filePath,
    name,
    ok: !pattern.test(content),
    message,
  };
}

function invariantChecksForFile(filePath: string, content: string, strictChangedFile: boolean): InvariantCheck[] {
  const checks: InvariantCheck[] = [];

  if (filePath.startsWith('lib/repositories/')) {
    checks.push(
      checkContains(
        filePath,
        content,
        'tenant resolver present',
        ['resolveEffectiveTenantId', 'getTenantIdFromHeaders'],
        'Repository files must resolve the effective tenant before service-role or Knex data access.',
      ),
      checkContains(
        filePath,
        content,
        'tenant filter present',
        ['applyTenantEq', ".eq('tenant_id'", '.eq("tenant_id"', 'tenant_id: tenantId', 'tenant_id: effectiveTenantId', 'set_tenant_context'],
        'Repository files must keep tenant_id filtering/inserts or explicit tenant context.',
      ),
    );

    if (strictChangedFile) {
      checks.push(
        checkNoPattern(
          filePath,
          content,
          'no invalid admin client arguments',
          /getSupabaseAdmin\([^)]+\)/,
          'Changed repository files must not add getSupabaseAdmin() tenant arguments; resolve and filter tenant scope separately.',
        ),
      );
    }
  }

  if (filePath === 'app/(builder)/ycode/api/publish/route.ts') {
    checks.push(
      checkContains(
        filePath,
        content,
        'publish tenant resolver present',
        ['resolveEffectiveTenantId', 'runWithEffectiveTenantId'],
        'Publish route must keep explicit tenant resolution so one tenant cannot publish another tenant.',
      ),
      checkContains(
        filePath,
        content,
        'publish tenant context wrapper present',
        ['runWithEffectiveTenantId'],
        'Publish route must execute publish work inside the effective tenant context.',
      ),
    );
  }

  if (filePath === 'proxy.ts') {
    checks.push(
      checkContains(
        filePath,
        content,
        'proxy tenant headers present',
        ['x-tenant-id', 'x-tenant-slug', 'resolveTenant'],
        'Proxy must continue resolving tenant subdomains and forwarding tenant headers.',
      ),
    );
  }

  if (filePath.includes('supabase-cookie') || filePath.includes('supabase-browser') || filePath.includes('supabase-route-client')) {
    checks.push(
      checkContains(
        filePath,
        content,
        'cookie domain handling present',
        ['TENANT_DOMAIN_SUFFIX', 'supabaseCookieOptionsFor', 'cookieOptions'],
        'Supabase client files must preserve shared tenant subdomain cookie handling.',
      ),
    );
  }

  return checks;
}

function readChangedOrGuardedFiles(): string[] {
  const changed = listAllowFailure('git diff --name-only origin/main...HEAD');
  const conflicted = listAllowFailure('git diff --name-only --diff-filter=U');
  return [...new Set([...changed, ...conflicted, ...TENANT_GUARD_FILES])].sort();
}

function main(): void {
  const outputPath = process.env.AUTOPILOT_GUARD_REPORT_PATH;
  const jsonOutputPath = process.env.AUTOPILOT_GUARD_REPORT_JSON_PATH;
  const files = readChangedOrGuardedFiles();
  const conflictFiles = listAllowFailure('git diff --name-only --diff-filter=U');
  const changedFiles = listAllowFailure('git diff --name-only origin/main...HEAD');
  const strictFiles = new Set([...changedFiles, ...conflictFiles]);
  const safety: UpdateSafetyResult = classifyUpdateRisk(changedFiles, conflictFiles);
  const checks: InvariantCheck[] = [];
  const conflictMarkerFiles: string[] = [];

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf8');
    if (hasConflictMarkers(content)) {
      conflictMarkerFiles.push(filePath);
    }
    checks.push(...invariantChecksForFile(filePath, content, strictFiles.has(filePath)));
  }

  const failedChecks = checks.filter((check) => !check.ok);
  const lines = [
    '# Core Update Autopilot v2 guard',
    '',
    formatUpdateSafetyReport(safety),
    '',
    '## Deterministic guard checks',
    '',
    `- Conflict marker files: **${conflictMarkerFiles.length}**`,
    `- Tenant invariant checks: **${checks.length}**`,
    `- Failed tenant invariant checks: **${failedChecks.length}**`,
  ];

  if (conflictMarkerFiles.length > 0) {
    lines.push('', '### Conflict markers still present', ...conflictMarkerFiles.map((file) => `- ${file}`));
  }

  if (failedChecks.length > 0) {
    lines.push('', '### Failed invariant checks');
    for (const check of failedChecks) {
      lines.push(`- ${check.filePath}: ${check.name} — ${check.message}`);
    }
  }

  if (outputPath) {
    writeFileSync(outputPath, `${lines.join('\n')}\n`);
  }

  if (jsonOutputPath) {
    writeFileSync(
      jsonOutputPath,
      `${JSON.stringify({ safety, conflictMarkerFiles, checks, failedChecks }, null, 2)}\n`,
    );
  }

  console.log(lines.join('\n'));

  if (conflictMarkerFiles.length > 0 || failedChecks.length > 0 || safety.status === 'blocked') {
    process.exit(2);
  }
}

main();
