/**
 * Tenant-scope codemod — the deterministic Tier-2 resolver.
 *
 * Given an upstream Ycode repository file (which has no tenant scoping), re-apply
 * the documented Tier-2 pattern (docs/masjidweb-core-seams.md §Tier 2):
 *   - imports for resolveEffectiveTenantId + applyTenantEq
 *   - `const tenantId = await resolveEffectiveTenantId()` in each function that
 *     queries a tenant table
 *   - `applyTenantEq(q, tenantId)` after an assigned read/update/delete chain
 *   - `tenant_id` on an object-literal insert/upsert payload
 *
 * It only transforms the forms it can do *mechanically and safely*; anything else
 * is left untouched and surfaces in `residual` (the caller then leaves that file
 * to the LLM fallback). The static isolation gate verifies the output regardless,
 * so a missed query is caught — never silently shipped. No tenant logic is
 * invented: the transform is the same three pieces a human applies by rote.
 */
import ts from 'typescript';
import { analyzeTenantIsolation, TENANT_SCOPED_TABLES } from './tenant-isolation-gate';

export interface CodemodResult {
  code: string;
  /** Human-readable description of each applied transform. */
  changes: string[];
  /** Tenant-table queries the codemod could not mechanically scope (left for fallback). */
  residual: { line: number; table: string; snippet: string }[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const IMPORT_TENANT_ID = "import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';";
const IMPORT_APPLY_EQ = "import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';";

const WRITE_METHODS = new Set(['insert', 'upsert']);
const FILTER_METHODS = new Set(['update', 'delete']);

function lineIndent(source: string, pos: number): string {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const m = source.slice(lineStart).match(/^[ \t]*/);
  return m ? m[0] : '';
}

/** Top of the fluent chain a `.from()` call belongs to. */
function chainTop(fromCall: ts.CallExpression): ts.Node {
  let cur: ts.Node = fromCall;
  for (;;) {
    const p = cur.parent;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === cur) {
      const call = p.parent;
      cur = call && ts.isCallExpression(call) && call.expression === p ? call : p;
      continue;
    }
    return cur;
  }
}

function classifyOp(fromCall: ts.CallExpression): 'read' | 'write' {
  let cur: ts.Node = fromCall;
  for (;;) {
    const p = cur.parent;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === cur) {
      const method = p.name.text;
      if (WRITE_METHODS.has(method)) return 'write';
      if (FILTER_METHODS.has(method)) return 'read';
      const call = p.parent;
      cur = call && ts.isCallExpression(call) ? call : p;
      continue;
    }
    return 'read';
  }
}

function enclosingFunctionBody(node: ts.Node): ts.Block | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      (ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isMethodDeclaration(cur)) &&
      cur.body &&
      ts.isBlock(cur.body)
    ) {
      return cur.body;
    }
    cur = cur.parent;
  }
  return null;
}

/** Existing `const <x> = await? resolveEffectiveTenantId()` name in this body, or null. */
function existingTenantVar(body: ts.Block): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      /resolveEffectiveTenantId\s*\(\s*\)/.test(n.initializer.getText())
    ) {
      found = n.name.text;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/** The `<x> = client.from(...)…` / `let <x> = …` variable this chain is assigned to. */
function assignedVar(top: ts.Node): { name: string; isConst: boolean; decl: ts.VariableDeclaration | null } | null {
  const p = top.parent;
  if (p && ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name)) {
    const declList = p.parent;
    const isConst = ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0;
    return { name: p.name.text, isConst, decl: p };
  }
  if (
    p &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === top &&
    ts.isIdentifier(p.left)
  ) {
    return { name: p.left.text, isConst: false, decl: null };
  }
  return null;
}

function statementOf(node: ts.Node): ts.Statement | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isStatement(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** First argument expression of the insert/upsert call whose object is this chain. */
function writeArg(fromCall: ts.CallExpression): ts.Expression | null {
  let cur: ts.Node = fromCall;
  for (;;) {
    const p = cur.parent;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === cur) {
      if (WRITE_METHODS.has(p.name.text)) {
        const call = p.parent;
        if (call && ts.isCallExpression(call) && call.arguments.length > 0) return call.arguments[0];
        return null;
      }
      const call = p.parent;
      cur = call && ts.isCallExpression(call) ? call : p;
      continue;
    }
    return null;
  }
}

/** Find `const/let <name> = <init>` within this function body. */
function findDeclInBody(body: ts.Block, name: string): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/** Object literal(s) that constitute a write payload: an inline literal, a
 *  `const row = {…}` variable, or the row literal inside `items.map(i => ({…}))`. */
function objectLiteralsFromExpression(expr: ts.Expression): ts.ObjectLiteralExpression[] {
  if (ts.isObjectLiteralExpression(expr)) return [expr];
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'map') {
    const cb = expr.arguments[0];
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
      const out: ts.ObjectLiteralExpression[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isObjectLiteralExpression(n)) out.push(n);
        else ts.forEachChild(n, visit);
      };
      if (ts.isBlock(cb.body)) ts.forEachChild(cb.body, visit);
      else visit(cb.body);
      return out;
    }
  }
  return [];
}

/** Resolve the object literal(s) to inject tenant_id into for a write. */
function writePayloadLiterals(fromCall: ts.CallExpression, body: ts.Block): ts.ObjectLiteralExpression[] {
  const arg = writeArg(fromCall);
  if (!arg) return [];
  if (ts.isIdentifier(arg)) {
    const decl = findDeclInBody(body, arg.text);
    return decl?.initializer ? objectLiteralsFromExpression(decl.initializer) : [];
  }
  return objectLiteralsFromExpression(arg);
}

export function reapplyTenantScoping(source: string, filePath = 'repo.ts'): CodemodResult {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  // Idempotent + aligned: only transform queries the gate considers unscoped, so
  // running on an already-scoped or partially-scoped file never double-applies.
  const unscoped = new Set(analyzeTenantIsolation(filePath, source).map((f) => `${f.line}:${f.table}`));
  const edits: Edit[] = [];
  const changes: string[] = [];
  const residual: CodemodResult['residual'] = [];
  let needTenantIdImport = false;
  let needApplyEqImport = false;
  // Track which function bodies already got a `const tenantId = …` inserted.
  const tenantVarByBody = new Map<ts.Block, string>();

  const ensureTenantVar = (body: ts.Block): string => {
    const existing = existingTenantVar(body);
    if (existing) return existing;
    const cached = tenantVarByBody.get(body);
    if (cached) return cached;
    // Insert at the start of the function body.
    const insertPos = body.getStart(sf) + 1; // after `{`
    const indent = lineIndent(source, body.statements[0]?.getStart(sf) ?? insertPos);
    edits.push({
      start: insertPos,
      end: insertPos,
      text: `\n${indent}const tenantId = await resolveEffectiveTenantId();`,
    });
    needTenantIdImport = true;
    tenantVarByBody.set(body, 'tenantId');
    return 'tenantId';
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'from' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      TENANT_SCOPED_TABLES.has(node.arguments[0].text)
    ) {
      const table = node.arguments[0].text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      // Already-scoped query (per the gate) → leave it untouched (idempotency).
      if (!unscoped.has(`${line}:${table}`)) {
        ts.forEachChild(node, visit);
        return;
      }
      const body = enclosingFunctionBody(node);
      const op = classifyOp(node);

      if (!body) {
        residual.push({ line, table, snippet: node.parent.getText(sf).slice(0, 80) });
        ts.forEachChild(node, visit);
        return;
      }

      if (op === 'write') {
        const literals = writePayloadLiterals(node, body).filter(
          (lit) => !/\btenant_id\b/.test(lit.getText(sf)),
        );
        if (literals.length > 0) {
          const tv = ensureTenantVar(body);
          for (const lit of literals) {
            const pos = lit.getStart(sf) + 1; // after `{`
            edits.push({ start: pos, end: pos, text: ` tenant_id: ${tv},` });
          }
          changes.push(`Added tenant_id to ${table} write payload (line ${line}).`);
        } else if (writePayloadLiterals(node, body).length === 0 && writeArg(node)) {
          // A payload we cannot resolve to an object literal (e.g. a spread-only
          // arg or a function result) — leave for the gate/LLM fallback.
          residual.push({ line, table, snippet: 'non-literal write payload' });
        }
        ts.forEachChild(node, visit);
        return;
      }

      // read / update / delete → needs applyTenantEq on the assigned variable
      const top = chainTop(node);
      const v = assignedVar(top);
      if (v && v.name) {
        const stmt = statementOf(top);
        if (stmt) {
          const tv = ensureTenantVar(body);
          // const → let so it can be reassigned.
          if (v.isConst && v.decl) {
            const declList = v.decl.parent;
            if (ts.isVariableDeclarationList(declList)) {
              const kwStart = declList.getStart(sf);
              edits.push({ start: kwStart, end: kwStart + 'const'.length, text: 'let' });
            }
          }
          const indent = lineIndent(source, stmt.getStart(sf));
          const insertPos = stmt.getEnd();
          edits.push({
            start: insertPos,
            end: insertPos,
            text: `\n${indent}${v.name} = applyTenantEq(${v.name}, ${tv});`,
          });
          needApplyEqImport = true;
          changes.push(`Scoped ${table} ${op} via applyTenantEq(${v.name}) (line ${line}).`);
          ts.forEachChild(node, visit);
          return;
        }
      }
      // Not assigned to a reassignable variable (inline `await client.from(...)`,
      // `return client.from(...)`, destructure, call argument, .map() callback…).
      // Wrap the chain inline: `applyTenantEq(<chain>, tenantId)`. The isolation
      // gate recognizes inline applyTenantEq() as scoped, and the `unscoped` guard
      // above keeps it idempotent (already-scoped chains are never re-wrapped).
      {
        const tv = ensureTenantVar(body);
        const start = top.getStart(sf);
        const end = top.getEnd();
        edits.push({ start, end: start, text: 'applyTenantEq(' });
        edits.push({ start: end, end, text: `, ${tv})` });
        needApplyEqImport = true;
        changes.push(`Scoped ${table} ${op} via inline applyTenantEq (line ${line}).`);
      }
      ts.forEachChild(node, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Imports: add any missing, after the last existing import.
  const importEdits: Edit[] = [];
  const hasImport = (s: string) => source.includes(s.split(' from ')[0]) && source.includes(s.split(' from ')[1]);
  const importsToAdd: string[] = [];
  if (needTenantIdImport && !/resolveEffectiveTenantId/.test(source.split('\n').filter((l) => l.startsWith('import')).join('\n'))) {
    importsToAdd.push(IMPORT_TENANT_ID);
  }
  if (needApplyEqImport && !/applyTenantEq/.test(source.split('\n').filter((l) => l.startsWith('import')).join('\n'))) {
    importsToAdd.push(IMPORT_APPLY_EQ);
  }
  if (importsToAdd.length > 0) {
    const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s));
    const pos = lastImport ? lastImport.getEnd() : 0;
    importEdits.push({ start: pos, end: pos, text: `\n${importsToAdd.join('\n')}` });
  }

  const all = [...edits, ...importEdits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of all) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  return { code: out, changes, residual };
}
