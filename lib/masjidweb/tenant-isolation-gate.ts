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
 */
import ts from 'typescript';

/**
 * Tables with a `tenant_id` column that MUST be tenant-scoped. Keep in sync with
 * masjidweb-backend TENANT_SCOPED_CONTENT_TABLES and public.delete_tenant_scoped_data.
 */
export const TENANT_SCOPED_TABLES: ReadonlySet<string> = new Set([
  'global_variables',
  'webhook_deliveries',
  'webhooks',
  'versions',
  'collection_imports',
  'api_keys',
  'mcp_tokens',
  'app_settings',
  'form_submissions',
  'collection_item_values',
  'collection_items',
  'page_layers',
  'collection_fields',
  'pages',
  'page_folders',
  'collections',
  'components',
  'layer_styles',
  'color_variables',
  'assets',
  'asset_folders',
  'fonts',
  'translations',
  'locales',
  'settings',
  'tenant_homepage_content',
]);

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
  // Tier-3 services that follow the same mechanical tenant-scoping pattern —
  // included so the codemod resolves them deterministically ($0) and the gate
  // enforces them, instead of deferring to the premium AI. (cacheService is
  // intentionally excluded — its invalidation logic is genuinely behavioral.)
  'lib/services/collectionService.ts',
  'lib/services/localisationService.ts',
  'lib/services/pageService.ts',
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
/** Methods that still require row-level tenant filtering (treated as reads here). */
const FILTERED_WRITE_METHODS = new Set(['update', 'delete']);

interface FromCall {
  node: ts.CallExpression;
  table: string;
  line: number;
}

/** Collect every `<expr>.from('literal')` call in the file. */
function collectFromCalls(sf: ts.SourceFile): FromCall[] {
  const out: FromCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'from' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const table = node.arguments[0].text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ node, table, line });
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

/** Is this chain an argument to a call to `applyTenantEq(...)`? (inline scoping) */
function isWrappedInApplyTenantEq(top: ts.Node): boolean {
  const parent = top.parent;
  return Boolean(
    parent &&
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === 'applyTenantEq' &&
      parent.arguments.includes(top as ts.Expression),
  );
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
  if (/\.eq\(\s*['"]tenant_id['"]/.test(chainText)) return true;
  if (isWrappedInApplyTenantEq(top)) return true;

  const v = assignedVar(top);
  if (!v) return false;
  const id = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!ID_RE.test(v)) return false;
  const text = scopeText(scope, sf);
  const passedToHelper = new RegExp(`applyTenantEq\\(\\s*${id}\\b`).test(text);
  const reassignedEq = new RegExp(`\\b${id}\\s*=\\s*${id}\\.eq\\(\\s*['"]tenant_id['"]`).test(text);
  const directEq = new RegExp(`\\b${id}\\.eq\\(\\s*['"]tenant_id['"]`).test(text);
  return passedToHelper || reassignedEq || directEq;
}

/**
 * Writes build their payload in the same function (`const row = { …tenant_id… };
 * client.from(t).upsert(row)`), so function-scoped evidence of a `tenant_id`
 * property/assignment is the right granularity here.
 */
function hasWriteScopeEvidence(text: string): boolean {
  return (
    /\btenant_id\b\s*:/.test(text) ||
    /\btenant_id\b\s*=/.test(text) ||
    /\bapplyTenantId\s*\(/.test(text) // payload wrapped in the applyTenantId() helper
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
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const froms = collectFromCalls(sf);
  if (froms.length === 0) return [];

  const hatches = escapeHatchLines(sf);
  const findings: IsolationFinding[] = [];

  for (const { node, table, line } of froms) {
    if (!TENANT_SCOPED_TABLES.has(table)) continue;
    // Escape hatch on the .from line or the line above.
    if (hatches.has(line) || hatches.has(line - 1)) continue;

    const op = classifyOp(node);
    const scope = enclosingScope(node);

    const ok =
      op === 'write'
        ? hasWriteScopeEvidence(scopeText(scope, sf))
        : readIsScoped(chainTop(node), sf, scope);
    if (!ok) {
      findings.push({
        file: filePath,
        line,
        table,
        op,
        fn: enclosingFunctionName(node, sf),
        reason:
          op === 'write'
            ? `insert/upsert into '${table}' has no tenant_id in its payload`
            : `query on '${table}' is not scoped with applyTenantEq() or .eq('tenant_id', ...)`,
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
