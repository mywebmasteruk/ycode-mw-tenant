/**
 * Tenant-isolation gate CLI — the safety proof for core updates.
 *
 * DIFFERENTIAL by design: it proves a safe-update does NOT reduce tenant scoping
 * versus the known-good baseline (default `origin/main`). The realistic threat is
 * an upstream merge / AI repair silently dropping an `applyTenantEq(...)` or a
 * `tenant_id` on a write; that shows up as a NEW unscoped tenant-table access
 * that is absent from the baseline. Pre-existing, legitimately-global patterns
 * (primary-key access, FK-validated reads, maintenance backfills) are baselined
 * out, so the gate has zero false positives on an unchanged tree.
 *
 * Exit 0 = no isolation regression. Exit 1 = the update weakened isolation; the
 * safe-update must NOT be approved.
 *
 * Usage:
 *   npx tsx scripts/core-update/run-tenant-isolation-gate.ts
 *   ISOLATION_GATE_BASELINE_REF=origin/main npx tsx scripts/core-update/run-tenant-isolation-gate.ts
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeTenantIsolation,
  formatFindings,
  isolationRegressions,
  TIER2_REPOSITORY_FILES,
  type IsolationFinding,
} from '../../lib/masjidweb/tenant-isolation-gate';

const REPO_ROOT = join(__dirname, '..', '..');
const BASELINE_REF = process.env.ISOLATION_GATE_BASELINE_REF?.trim() || 'origin/main';

function gatedFiles(): string[] {
  // Default to the Tier-2 set; allow an explicit changed-file list, intersected
  // with files that follow the tenant pattern so Tier-3 services aren't misflagged.
  const fromArgs = process.argv.slice(2).filter((a) => a.endsWith('.ts'));
  const tier2 = new Set(TIER2_REPOSITORY_FILES);
  if (fromArgs.length > 0) {
    return fromArgs.filter((f) => tier2.has(f) || f.startsWith('lib/repositories/'));
  }
  return [...TIER2_REPOSITORY_FILES];
}

function readWorkingTree(rel: string): string | null {
  const abs = join(REPO_ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

function readBaseline(rel: string): string | null {
  try {
    return execSync(`git show ${BASELINE_REF}:${rel}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // file is new in the merge — no baseline; analyzed absolutely below
  }
}

function main(): void {
  const files = gatedFiles();
  const baseline: IsolationFinding[] = [];
  const merged: IsolationFinding[] = [];
  let scanned = 0;

  for (const rel of files) {
    const cur = readWorkingTree(rel);
    if (cur === null) continue;
    scanned += 1;
    merged.push(...analyzeTenantIsolation(rel, cur));
    const base = readBaseline(rel);
    if (base !== null) baseline.push(...analyzeTenantIsolation(rel, base));
    // If base is null (new file), its findings stay out of the baseline, so any
    // unscoped query in a brand-new repo file is correctly treated as a regression.
  }

  const regressions = isolationRegressions(baseline, merged);

  console.log(
    `Tenant-isolation gate: scanned ${scanned} repository file(s) against ${BASELINE_REF}.`,
  );
  if (regressions.length === 0) {
    console.log(
      'Tenant-isolation gate: PASS — the update did not drop tenant scoping on any tenant table.',
    );
    return;
  }

  console.error(formatFindings(regressions));
  console.error(
    '\nTenant-isolation gate FAILED — this update REMOVED tenant scoping that ' +
      `existed on ${BASELINE_REF}. Re-apply the dropped applyTenantEq()/tenant_id, ` +
      'or, for a genuinely-global query, add `// isolation-ok: <reason>` above the .from(). ' +
      'Approval is blocked until the gate passes.',
  );
  process.exit(1);
}

main();
