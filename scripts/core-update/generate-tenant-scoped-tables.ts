/**
 * Phase 3 (schema-driven isolation gate): regenerate
 * lib/masjidweb/tenant-scoped-tables.generated.ts from the LIVE production schema.
 *
 * The tenant-isolation gate requires every `client.from('<tenant table>')` query
 * to be tenant-scoped. The set of tenant tables is "every public table with a
 * tenant_id column" — read here straight from information_schema so it can never
 * silently drift from the database (the old hand-curated Set was already missing
 * provisioning_audit_log).
 *
 * Run after a Ycode core update changes the schema (the Phase 2 tripwire,
 * public.mw_unclassified_tables, tells you when a new table appears):
 *
 *     SUPABASE_ACCESS_TOKEN=<pat> npx tsx scripts/core-update/generate-tenant-scoped-tables.ts
 *
 * Optional env: SUPABASE_PROJECT_REF (default the prod project).
 *
 * Read-only against the DB; writes one generated file. Content is sorted and
 * deterministic, so a no-change run produces no diff.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF || 'jofgypmriaqphnsyxiks';
const OUT = join(__dirname, '..', '..', 'lib', 'masjidweb', 'tenant-scoped-tables.generated.ts');

if (!PAT) {
  console.error('SUPABASE_ACCESS_TOKEN (a Supabase PAT) is required.');
  process.exit(1);
}

async function runSql<T>(query: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

function renderSet(name: string, doc: string, tables: string[]): string {
  const body = tables.map((t) => `  '${t}',`).join('\n');
  return `/** ${doc} */\nexport const ${name}: ReadonlySet<string> = new Set([\n${body}\n]);`;
}

async function main(): Promise<void> {
  const scoped = await runSql<{ table_name: string }>(
    `select table_name from information_schema.columns
     where table_schema='public' and column_name='tenant_id' order by table_name`,
  );
  const global = await runSql<{ table_name: string }>(
    `select t.table_name from information_schema.tables t
     where t.table_schema='public' and t.table_type='BASE TABLE'
       and not exists (
         select 1 from information_schema.columns c
         where c.table_schema='public' and c.table_name=t.table_name and c.column_name='tenant_id')
     order by t.table_name`,
  );

  const scopedNames = scoped.map((r) => r.table_name);
  const globalNames = global.map((r) => r.table_name);

  const header = `// MASJIDWEB_SEAM: schema-driven-isolation — see docs/masjidweb-core-seams.md#tier-0
//
// GENERATED FILE — do not edit by hand.
//
// Source of truth: the LIVE production schema (every public table that has a
// \`tenant_id\` column). Regenerate after a Ycode core update adds/removes a
// tenant-scoped table:
//
//     SUPABASE_ACCESS_TOKEN=<pat> npx tsx scripts/core-update/generate-tenant-scoped-tables.ts
//
// The static tenant-isolation gate (tenant-isolation-gate.ts) requires every
// \`client.from('<TENANT_SCOPED_TABLE>')\` query to be tenant-scoped. Because this
// list is derived from the schema (not hand-curated), a new tenant_id table is
// auto-required to be scoped once this file is regenerated — no manual Set edit.
// The Phase 2 dashboard tripwire (mw_unclassified_tables) flags the new table so
// you know to regenerate.
//
// Content is purely schema-determined (sorted), so regenerating is a no-op diff
// unless the schema actually changed. GLOBAL_TABLES are listed for
// completeness/auditing; the gate ignores them (no tenant_id, genuinely
// cross-tenant/system).`;

  const out = `${header}\n\n${renderSet(
    'TENANT_SCOPED_TABLES',
    'Public tables that have a `tenant_id` column and MUST be tenant-scoped.',
    scopedNames,
  )}\n\n${renderSet(
    'GLOBAL_TABLES',
    'Public tables with NO `tenant_id` column (genuinely global / system / platform).',
    globalNames,
  )}\n`;

  writeFileSync(OUT, out);
  console.log(
    `Wrote ${OUT}\n  ${scopedNames.length} tenant-scoped, ${globalNames.length} global tables.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
