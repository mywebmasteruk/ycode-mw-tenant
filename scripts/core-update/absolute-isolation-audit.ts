/**
 * ABSOLUTE tenant-isolation audit — scans EVERY .ts/.tsx file in the codebase
 * (not just the 19 TIER2 files the gate checks) and reports every unscoped
 * query against a tenant-scoped table. This finds existing leaks, not just
 * regressions.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analyzeTenantIsolation, type IsolationFinding } from '../../lib/masjidweb/tenant-isolation-gate';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['lib', 'app'];
const SKIP = /(\.test\.ts$|\.spec\.ts$|__tests__|\.d\.ts$)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(p) && !SKIP.test(p)) {
      out.push(p);
    }
  }
  return out;
}

const all: IsolationFinding[] = [];
let scanned = 0;
for (const d of SCAN_DIRS) {
  const base = join(ROOT, d);
  for (const abs of walk(base)) {
    const rel = relative(ROOT, abs);
    const src = readFileSync(abs, 'utf8');
    try {
      const f = analyzeTenantIsolation(rel, src);
      scanned += 1;
      all.push(...f);
    } catch (e) {
      console.error(`PARSE-ERROR ${rel}: ${(e as Error).message}`);
    }
  }
}

console.log(`Scanned ${scanned} files. Found ${all.length} unscoped tenant-table access(es).\n`);

// group by file
const byFile = new Map<string, IsolationFinding[]>();
for (const f of all) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file)!.push(f);
}
const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [file, findings] of sorted) {
  console.log(`\n### ${file}  (${findings.length})`);
  for (const f of findings) {
    console.log(`  L${f.line} [${f.op}] ${f.table}  fn=${f.fn}  — ${f.reason}`);
  }
}
