/**
 * Static tenant-isolation gate.
 *
 * Enforces the contract in docs/masjidweb-core-seams.md (Principle 5, line 17):
 * "every getSupabaseAdmin() read/write path must respect the effective tenant."
 *
 * For every `client.from('<tenant table>')` query in a source file:
 *  - select / update / delete  → the same enclosing function must scope it with
 *    `applyTenantEq(...)` or a literal `.eq('tenant_id', ...)`.
 *  - insert / upsert           → the payload must carry a `tenant_id` property.
 *
 * This is a *proof over the diff*, not a test: any resolution path (deterministic
 * seam re-apply, AI repair, or a human) that drops tenant scoping fails the gate
 * and blocks the safe-update from being approved. An explicit, auditable escape
 * hatch `// isolation-ok: <reason>` on the line above a `.from()` documents the
 * rare legitimately-global query.
 *
 * Pure (string in → findings out) so it is unit-testable without a live Supabase.
 *
 * Two query dialects are analyzed, because tenant data reaches Postgres by two
 * routes and NEITHER is covered by database-side isolation today:
 *
 *  1. supabase-js / PostgREST — `<expr>.from('<table>')`, via the service-role key
 *     (`rolbypassrls = true`).
 *  2. Knex direct-PG — `knex('<table>')` / `trx('<table>')`, as `postgres`, which
 *     also has `rolbypassrls = true`. Not even FORCE ROW LEVEL SECURITY constrains
 *     a BYPASSRLS role, so app-layer scoping is the only control on this path.
 *
 * Knex used to be unanalyzed here, deferred to a file-level substring check in
 * `autopilot-tenant-invariants.ts` ("knex tenant filter present"). That check is
 * satisfied by the string `getTenantIdFromHeaders` appearing ANYWHERE in the file,
 * so it passed upstream 1.30.3's `getValuesByItemIds()` — which read
 * `collection_item_values` over Knex with no tenant filter — because the file
 * happened to contain a scoped Knex query elsewhere. Verified 2026-08-21: the only
 * reason that merge was caught at all was an incidental `getSupabaseAdmin(tenantId)`
 * signature rule; normalising that one call made the file pass every check with the
 * unscoped cross-tenant read still in place. Hence per-query-site AST analysis for
 * Knex too.
 */
import ts from 'typescript';

/**
 * Tables with a `tenant_id` column that MUST be tenant-scoped.
 *
 * MASJIDWEB_SEAM: schema-driven-isolation — this set is GENERATED from the live
 * production schema (tenant-scoped-tables.generated.ts), not hand-curated, so a
 * new tenant_id table from a Ycode core update is auto-required to be scoped once
 * the generated file is refreshed. Regenerate with
 * `scripts/core-update/generate-tenant-scoped-tables.ts`. See
 * docs/masjidweb-core-seams.md#tier-0.
 */
export { TENANT_SCOPED_TABLES, GLOBAL_TABLES } from './tenant-scoped-tables.generated';
import { TENANT_SCOPED_TABLES } from './tenant-scoped-tables.generated';

/**
 * The Tier-2 repository files that follow the mechanical tenant pattern
 * (docs/masjidweb-core-seams.md §Tier 2). These are where a bad upstream merge
 * can silently drop `applyTenantEq`/`tenant_id`, so they are the gate's core
 * scope. New upstream files that call getSupabaseAdmin() without scoping should
 * be added here (per the core-update playbook). Tier-3 services scope via cache
 * tags / trusted ids and are intentionally out of this gate's scope.
 */
export const TIER2_REPOSITORY_FILES: readonly string[] = [
  'lib/repositories/pageRepository.ts',
  'lib/repositories/pageLayersRepository.ts',
  'lib/repositories/pageFolderRepository.ts',
  'lib/repositories/settingsRepository.ts',
  'lib/repositories/collectionRepository.ts',
  'lib/repositories/collectionFieldRepository.ts',
  'lib/repositories/collectionItemRepository.ts',
  'lib/repositories/collectionItemValueRepository.ts',
  'lib/repositories/collectionImportRepository.ts',
  'lib/repositories/componentRepository.ts',
  'lib/repositories/layerStyleRepository.ts',
  'lib/repositories/localeRepository.ts',
  'lib/repositories/fontRepository.ts',
  'lib/repositories/assetRepository.ts',
  'lib/repositories/assetFolderRepository.ts',
  'lib/repositories/colorVariableRepository.ts',
  // Auxiliary repositories that query tenant tables the same mechanical way.
  // (2026-06-28: these were never scoped originally and leaked across tenants;
  // now scoped + gated so updates can't regress them.)
  'lib/repositories/versionRepository.ts',
  'lib/repositories/webhookRepository.ts',
  'lib/repositories/appSettingsRepository.ts',
  'lib/repositories/translationRepository.ts',
  'lib/repositories/apiKeyRepository.ts',
  'lib/repositories/formSubmissionRepository.ts',
  'lib/repositories/mcpTokenRepository.ts',
  // Tier-3 services / utilities that follow the same mechanical tenant-scoping
  // pattern — included so the codemod resolves them deterministically ($0) and
  // the gate enforces them, instead of deferring to the premium AI.
  'lib/services/collectionService.ts',
  'lib/services/localisationService.ts',
  'lib/services/pageService.ts',
  'lib/services/cacheService.ts',
  'lib/asset-usage-utils.ts',
  'lib/collection-usage-utils.ts',
];

export type QueryOp = 'read' | 'write';

export interface IsolationFinding {
  file: string;
  line: number;
  table: string;
  op: QueryOp;
  /** Enclosing function name (stable across line shifts) — used for differential keying. */
  fn: string;
  reason: string;
}

/**
 * Stable identity for a finding that survives line-number shifts between the
 * pre-merge baseline and the merged file. A finding is a regression only if this
 * key is absent from the baseline.
 */
export function findingKey(f: IsolationFinding): string {
  return `${f.file}::${f.fn}::${f.table}::${f.op}`;
}

const ESCAPE_HATCH = /isolation-ok:/;

/** Method names that make a `.from(table)` chain a write rather than a read. */
const WRITE_METHODS = new Set(['insert', 'upsert']);
/** Methods that still require row-level tenant filtering (treated as reads here).
 *  `del` is Knex's alias for `delete`. */
const FILTERED_WRITE_METHODS = new Set(['update', 'delete', 'del']);

/**
 * Identifiers that denote a Knex query builder, so `<id>('table')` is a direct-PG
 * query. Covers `const knex = await getKnexClient()` and the transaction callback
 * parameter in `knex.transaction(async (trx) => trx('table')…)`.
 */
const KNEX_BINDINGS = new Set(['knex', 'trx', 'tx', 'db']);

/** Which route a query takes to Postgres. Recorded so findings name the real risk. */
type Dialect = 'postgrest' | 'knex';

interface FromCall {
  node: ts.CallExpression;
  table: string;
  line: number;
  dialect: Dialect;
}

/**
 * Collect every tenant-table query entrypoint: supabase-js `<expr>.from('literal')`
 * and Knex `knex('literal')` / `trx('literal')`.
 */
function collectFromCalls(sf: ts.SourceFile): FromCall[] {
  const out: FromCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const table = node.arguments[0].text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const isPostgrest =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'from' &&
        node.arguments.length === 1;
      // Knex is a bare identifier call, not a property access.
      const isKnex = ts.isIdentifier(node.expression) && KNEX_BINDINGS.has(node.expression.text);
      if (isPostgrest) out.push({ node, table, line, dialect: 'postgrest' });
      else if (isKnex) out.push({ node, table, line, dialect: 'knex' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Best-effort name of the enclosing function/method for stable diffing. */
function enclosingFunctionName(node: ts.Node, sf: ts.SourceFile): string {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      cur.parent &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
    cur = cur.parent;
  }
  return '<module>';
}

/**
 * Nearest enclosing NAMED function (declaration, method, or arrow/function bound to
 * a variable), falling back to the source file.
 *
 * Write evidence must be gathered at this granularity, not at `enclosingScope()`.
 * Knex writes run inside a transaction callback — `knex.transaction(async (trx) =>
 * trx('t').insert(rows))` — while `rows` is built in the OUTER function. Using the
 * immediate arrow scope there reports a false positive on correctly-scoped code.
 */
function enclosingNamedFunctionScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) || ts.isConstructorDeclaration(cur)) return cur;
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      cur.parent &&
      ts.isVariableDeclaration(cur.parent)
    ) {
      return cur;
    }
    if (ts.isSourceFile(cur)) return cur;
    cur = cur.parent;
  }
  return node.getSourceFile();
}

/** Nearest enclosing function-like node (or the source file if top-level). */
function enclosingScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isSourceFile(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return node.getSourceFile();
}

/**
 * Classify the `.from()` chain. Walk up the property-access/call chain from the
 * `.from(...)` call and note the terminal builder method.
 */
function classifyOp(fromCall: ts.CallExpression): QueryOp {
  let cur: ts.Node = fromCall;
  // Walk outward through `.method(...)` chaining while this node is the object.
  for (;;) {
    const parent = cur.parent;
    if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === cur
    ) {
      const method = parent.name.text;
      if (WRITE_METHODS.has(method)) return 'write';
      if (FILTERED_WRITE_METHODS.has(method)) return 'read'; // needs a tenant filter
      const call = parent.parent;
      cur = call && ts.isCallExpression(call) ? call : parent;
      continue;
    }
    return 'read';
  }
}

function scopeText(scope: ts.Node, sf: ts.SourceFile): string {
  return scope.getFullText(sf);
}

const ID_RE = /[A-Za-z_$][\w$]*/;

/**
 * Filter methods that NARROW a query to a tenant. supabase-js contributes `eq`;
 * Knex contributes `where` / `andWhere` / `whereIn`. `orWhere` is deliberately
 * excluded — it WIDENS the result set, so `.orWhere('tenant_id', …)` is not a scope.
 */
const SCOPE_METHOD_ALT = '(?:eq|where|andWhere|whereIn)';

/** Top of the fluent query chain that this `.from(...)` call belongs to. */
function chainTop(fromCall: ts.CallExpression): ts.Node {
  let cur: ts.Node = fromCall;
  for (;;) {
    const parent = cur.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === cur) {
      const call = parent.parent;
      cur = call && ts.isCallExpression(call) && call.expression === parent ? call : parent;
      continue;
    }
    return cur;
  }
}

/** Variable this query chain is assigned to (`let q = …` / `q = …`), or null. */
function assignedVar(top: ts.Node): string | null {
  const parent = top.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === top && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === top &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left.text;
  }
  return null;
}

/**
 * Helpers that apply a tenant filter to a query, treated as equivalent to an
 * inline `.eq('tenant_id', …)`:
 *  - `applyTenantEq(q, tid)`               → `.eq('tenant_id', tid)`
 *  - `applyTenantOrLegacyScope(q, tid)`    → `tenant_id = tid OR tenant_id IS NULL`
 *  - `scopeCollectionItemTimestampUpdate(q, itemId, tid)` → `.eq('tenant_id', tid)`
 * The query chain is always the first argument to each.
 */
const SCOPE_HELPERS = new Set([
  'applyTenantEq',
  'applyTenantOrLegacyScope',
  'scopeCollectionItemTimestampUpdate',
]);
const SCOPE_HELPER_ALT = '(?:applyTenantEq|applyTenantOrLegacyScope|scopeCollectionItemTimestampUpdate)';

/**
 * Knex-side equivalent: `addTenantFilter(knex, query, 'table')` (lib/knex-helpers.ts)
 * appends the tenant predicate to a Knex builder. Its query argument is at index 1,
 * NOT 0 — the builder is the second parameter, after the knex instance.
 */
const KNEX_SCOPE_HELPERS = new Set(['addTenantFilter']);
const KNEX_SCOPE_HELPER_ALT = '(?:addTenantFilter)';

/** Index of the query argument for a recognized scope helper, or -1 if not one. */
function scopeHelperArgIndex(name: string): number {
  if (SCOPE_HELPERS.has(name)) return 0;
  if (KNEX_SCOPE_HELPERS.has(name)) return 1;
  return -1;
}

/** Is this chain the query argument of a recognized tenant-scope helper? (inline scoping)
 *  Position matters — a chain passed anywhere else (e.g. `applyTenantEq(other, <chain>)`)
 *  is NOT scoped, so the expected index per helper is checked exactly. */
function isWrappedInScopeHelper(top: ts.Node): boolean {
  const parent = top.parent;
  if (!parent || !ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) return false;
  const idx = scopeHelperArgIndex(parent.expression.text);
  return idx >= 0 && parent.arguments[idx] === top;
}

/** Strip line/block comments so commented-out scope calls can't satisfy the
 *  assigned-var evidence regexes below. String literals are preserved (the
 *  regexes need the literal `'tenant_id'`); a string that merely *mentions* a
 *  helper is a negligible vector. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Read/update/delete on a tenant table must be filtered. Evidence, in order:
 *  - the chain itself carries `.eq('tenant_id', …)`, or
 *  - the chain is wrapped inline in `applyTenantEq(<chain>, …)`, or
 *  - the chain is assigned to `q` and the enclosing scope passes that exact `q`
 *    to `applyTenantEq(q, …)` or reassigns it with `q = q.eq('tenant_id', …)`.
 * Per-variable (not per-function) so one scoped query can't vouch for another.
 */
function readIsScoped(top: ts.Node, sf: ts.SourceFile, scope: ts.Node): boolean {
  const chainText = top.getText(sf);
  // Inline supabase-js `.eq('tenant_id', …)` or Knex `.where/.andWhere('tenant_id', …)`.
  if (new RegExp(`\\.${SCOPE_METHOD_ALT}\\(\\s*['"]tenant_id['"]`).test(chainText)) return true;
  if (isWrappedInScopeHelper(top)) return true;

  const v = assignedVar(top);
  if (!v) return false;
  const id = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!ID_RE.test(v)) return false;
  const text = stripComments(scopeText(scope, sf));
  // Helper name must not be a suffix of a longer identifier (e.g. `xapplyTenantEq`).
  const passedToHelper = new RegExp(`(?<![\\w$])${SCOPE_HELPER_ALT}\\(\\s*${id}\\b`).test(text);
  // Knex helper takes the builder as its SECOND argument: addTenantFilter(knex, q, 'table').
  const passedToKnexHelper = new RegExp(
    `(?<![\\w$])${KNEX_SCOPE_HELPER_ALT}\\(\\s*[^,()]+,\\s*${id}\\b`,
  ).test(text);
  const reassignedEq = new RegExp(`\\b${id}\\s*=\\s*${id}\\.${SCOPE_METHOD_ALT}\\(\\s*['"]tenant_id['"]`).test(text);
  const directEq = new RegExp(`\\b${id}\\.${SCOPE_METHOD_ALT}\\(\\s*['"]tenant_id['"]`).test(text);
  return passedToHelper || passedToKnexHelper || reassignedEq || directEq;
}

/**
 * Writes build their payload in the same function (`const row = { …tenant_id… };
 * client.from(t).upsert(row)`), so function-scoped evidence of a `tenant_id`
 * property/assignment is the right granularity here.
 */
function hasWriteScopeEvidence(text: string): boolean {
  // Comments are stripped first: prose that merely mentions `tenant_id:` must not
  // vouch for a write (upstream's Knex insert carries exactly such a comment while
  // omitting the column).
  const src = stripComments(text);
  return (
    /\btenant_id\b\s*:/.test(src) ||
    /\btenant_id\b\s*=/.test(src) ||
    /\bapplyTenantId\s*\(/.test(src) // payload wrapped in the applyTenantId() helper
  );
}

/** Lines (1-based) that carry the `isolation-ok:` escape hatch. */
function escapeHatchLines(sf: ts.SourceFile): Set<number> {
  const lines = new Set<number>();
  const full = sf.getFullText();
  full.split('\n').forEach((l, i) => {
    if (ESCAPE_HATCH.test(l)) lines.add(i + 1);
  });
  return lines;
}

/**
 * Analyze one source file for tenant-isolation violations.
 * Returns an empty array when the file proves isolation (or touches no tenant tables).
 */
export function analyzeTenantIsolation(filePath: string, source: string): IsolationFinding[] {
  // Migrations are inherently cross-tenant: they run once, as the schema owner,
  // to reshape or backfill EVERY tenant's rows. Demanding a tenant filter there
  // would be wrong, and blanket `isolation-ok` hatches would only add noise.
  if (/(^|\/)database\/migrations\//.test(filePath)) return [];

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const froms = collectFromCalls(sf);
  if (froms.length === 0) return [];

  const hatches = escapeHatchLines(sf);
  const findings: IsolationFinding[] = [];

  for (const { node, table, line, dialect } of froms) {
    if (!TENANT_SCOPED_TABLES.has(table)) continue;
    // Escape hatch on the query line or the line above.
    if (hatches.has(line) || hatches.has(line - 1)) continue;

    const op = classifyOp(node);
    const scope = enclosingScope(node);

    const ok =
      op === 'write'
        ? hasWriteScopeEvidence(scopeText(enclosingNamedFunctionScope(node), sf))
        : readIsScoped(chainTop(node), sf, scope);
    if (!ok) {
      const via = dialect === 'knex' ? ' via direct-PG Knex (RLS does NOT apply)' : '';
      findings.push({
        file: filePath,
        line,
        table,
        op,
        fn: enclosingFunctionName(node, sf),
        reason:
          op === 'write'
            ? `insert/upsert into '${table}'${via} has no tenant_id in its payload`
            : `query on '${table}'${via} is not scoped with applyTenantEq() or .eq/.where('tenant_id', ...)`,
      });
    }
  }

  return findings;
}

/** Analyze many files; returns all findings flattened. */
export function analyzeFiles(
  files: { path: string; source: string }[],
): IsolationFinding[] {
  return files.flatMap((f) => analyzeTenantIsolation(f.path, f.source));
}

/**
 * Differential gate: a finding in `merged` is a regression only if its stable
 * key is absent from `baseline` (the known-good pre-merge `main`). This proves
 * the update does not REDUCE tenant scoping, without re-auditing pre-existing,
 * legitimately-global patterns (PK access, FK-validated, maintenance backfills).
 */
export function isolationRegressions(
  baseline: IsolationFinding[],
  merged: IsolationFinding[],
): IsolationFinding[] {
  const baseKeys = new Set(baseline.map(findingKey));
  return merged.filter((f) => !baseKeys.has(findingKey(f)));
}

export function formatFindings(findings: IsolationFinding[]): string {
  if (findings.length === 0) return 'Tenant-isolation gate: PASS — every tenant-table query is scoped.';
  const lines = findings.map(
    (f) => `  ✗ ${f.file}:${f.line} — ${f.reason}`,
  );
  return [
    `Tenant-isolation gate: FAIL — ${findings.length} unscoped tenant-table access(es):`,
    ...lines,
    '',
    "Fix: scope the query (applyTenantEq / .eq('tenant_id', …) / tenant_id in payload),",
    'or, for a genuinely global query, add `// isolation-ok: <reason>` above the .from().',
  ].join('\n');
}
