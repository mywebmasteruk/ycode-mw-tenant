/**
 * Deterministic Tier-2 conflict resolver — the primary resolver for core updates.
 *
 * For each conflicted Tier-2 repository file, take UPSTREAM's version of the file
 * (git merge stage 3) and re-apply the documented tenant pattern via the codemod
 * (lib/masjidweb/tenant-scope-codemod.ts). Accept the result ONLY if the static
 * isolation gate proves it introduced no new unscoped query versus origin/main;
 * otherwise leave the file conflicted for the AI fallback. No tenant logic is
 * synthesized — the transform is the mechanical three-piece pattern, and the gate
 * is the proof. Runs BEFORE the LLM so mechanical conflicts never reach it.
 *
 * Must run while the working tree is mid-merge (conflict markers present), so
 * `git show :3:<file>` resolves the upstream side.
 *
 * Exit 0 always (it is a best-effort pre-pass); prints a summary and, in GitHub
 * Actions, writes resolved/deferred counts to $GITHUB_OUTPUT.
 */
import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reapplyTenantScoping } from '../../lib/masjidweb/tenant-scope-codemod';
import {
  analyzeTenantIsolation,
  isolationRegressions,
  TIER2_REPOSITORY_FILES,
} from '../../lib/masjidweb/tenant-isolation-gate';

const REPO_ROOT = join(__dirname, '..', '..');
const BASELINE_REF = process.env.ISOLATION_GATE_BASELINE_REF?.trim() || 'origin/main';

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function tryGit(args: string): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function conflictedFiles(): string[] {
  const out = tryGit('diff --name-only --diff-filter=U') ?? '';
  const fromIndex = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (fromIndex.length > 0) return fromIndex;
  // Fallback: the branch may carry committed conflict markers (not an active
  // merge). Scan the Tier-2 set for marker content.
  return TIER2_REPOSITORY_FILES.filter((f) => {
    const c = tryGit(`show HEAD:${f}`);
    return c !== null && c.includes('<<<<<<<');
  });
}

/**
 * Resolve conflict markers by taking the UPSTREAM (theirs) side of each block —
 * supports 2-way and diff3 markers. The codemod then re-applies tenant scoping,
 * and the gate proves the result. Returns null if markers are malformed.
 */
export function takeTheirs(content: string): string | null {
  const lines = content.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      // Skip to '=======' (past any '|||||||' base section), then keep theirs
      // until '>>>>>>>'.
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('=======')) j += 1;
      if (j >= lines.length) return null;
      let k = j + 1;
      const theirs: string[] = [];
      while (k < lines.length && !lines[k].startsWith('>>>>>>>')) {
        theirs.push(lines[k]);
        k += 1;
      }
      if (k >= lines.length) return null;
      out.push(...theirs);
      i = k + 1;
    } else {
      out.push(lines[i]);
      i += 1;
    }
  }
  return out.join('\n');
}

function main(): void {
  const tier2 = new Set(TIER2_REPOSITORY_FILES);
  const targets = conflictedFiles().filter((f) => tier2.has(f));

  const resolved: string[] = [];
  const deferred: { file: string; reason: string }[] = [];

  for (const file of targets) {
    // Upstream (theirs) view: prefer the merge stage; else resolve the file's
    // own conflict markers to the upstream side.
    let upstream = tryGit(`show :3:${file}`);
    if (upstream === null) {
      const withMarkers = readFileSync(join(REPO_ROOT, file), 'utf8');
      upstream = withMarkers.includes('<<<<<<<') ? takeTheirs(withMarkers) : withMarkers;
    }
    if (upstream === null) {
      deferred.push({ file, reason: 'could not resolve upstream side (malformed conflict)' });
      continue;
    }

    const { code, residual } = reapplyTenantScoping(upstream, file);

    // Prove isolation vs the baseline before accepting.
    const baseSrc = tryGit(`show ${BASELINE_REF}:${file}`);
    const baseline = baseSrc !== null ? analyzeTenantIsolation(file, baseSrc) : [];
    const after = analyzeTenantIsolation(file, code);
    const regressions = isolationRegressions(baseline, after);

    if (regressions.length === 0 && residual.length === 0) {
      writeFileSync(join(REPO_ROOT, file), code);
      git(`add ${file}`);
      resolved.push(file);
    } else {
      const why =
        regressions.length > 0
          ? `gate found ${regressions.length} unscoped quer(y/ies) the codemod could not re-apply`
          : `${residual.length} query form(s) the codemod cannot mechanically scope`;
      deferred.push({ file, reason: why });
    }
  }

  console.log(`Deterministic Tier-2 resolver: ${targets.length} conflicted Tier-2 file(s).`);
  if (resolved.length > 0) {
    console.log(`  Resolved deterministically (gate-proven, $0):`);
    for (const f of resolved) console.log(`    ✓ ${f}`);
  }
  if (deferred.length > 0) {
    console.log(`  Deferred to AI fallback:`);
    for (const d of deferred) console.log(`    → ${d.file} (${d.reason})`);
  }
  if (targets.length === 0) console.log('  No Tier-2 repository conflicts to resolve.');

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tier2_resolved=${resolved.length}\ntier2_deferred=${deferred.length}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### Deterministic Tier-2 resolver\nResolved ${resolved.length} file(s) for $0; deferred ${deferred.length} to AI.\n`,
    );
  }
}

// Run only as a CLI, not when imported by tests.
if (process.argv[1]?.includes('run-tenant-codemod-resolver')) {
  main();
}
