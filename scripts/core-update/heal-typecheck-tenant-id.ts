/**
 * Same-run type-check heal for core updates.
 *
 * Premium AI / the Tier-2 codemod can leave a function using `tenantId` (for
 * example `tenant_id: tenantId` on an insert payload) without declaring
 * `const tenantId = await resolveEffectiveTenantId()` in that function. The
 * repair workflow used to fail type-check and stop, which sent the dashboard
 * back to "click Fix again". This heal runs in the same job, inserts the
 * missing declaration (and import), then the workflow type-checks again.
 *
 * Only heals undeclared `tenantId` / `effectiveTenantId` / `__effectiveTenantId`
 * in async functions — the MasjidWeb repository pattern. Anything else still
 * fails type-check and keeps approval locked.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const TENANT_NAMES = new Set(['tenantId', 'effectiveTenantId', '__effectiveTenantId']);
const IMPORT_TENANT_ID = "import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';";

function isFunctionLike(
  node: ts.Node,
): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function isNestedFunctionLike(node: ts.Node, body: ts.Block): boolean {
  return node !== body && isFunctionLike(node);
}

function isValueUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return false;
  return true;
}

function functionIsAsync(body: ts.Block): boolean {
  const fn = body.parent;
  if (
    fn &&
    (ts.isFunctionDeclaration(fn) ||
      ts.isFunctionExpression(fn) ||
      ts.isArrowFunction(fn) ||
      ts.isMethodDeclaration(fn))
  ) {
    return Boolean(fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
  }
  return false;
}

function nameDeclaredInFunction(body: ts.Block, name: string): boolean {
  const fn = body.parent;
  if (
    fn &&
    (ts.isFunctionDeclaration(fn) ||
      ts.isFunctionExpression(fn) ||
      ts.isArrowFunction(fn) ||
      ts.isMethodDeclaration(fn))
  ) {
    for (const p of fn.parameters) {
      if (ts.isIdentifier(p.name) && p.name.text === name) return true;
    }
  }
  let declared = false;
  const visit = (n: ts.Node): void => {
    if (isNestedFunctionLike(n, body)) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      declared = true;
      return;
    }
    if (!declared) ts.forEachChild(n, visit);
  };
  visit(body);
  return declared;
}

function nameUsedInFunction(body: ts.Block, name: string): boolean {
  let used = false;
  const visit = (n: ts.Node): void => {
    if (isNestedFunctionLike(n, body) && isFunctionLike(n)) {
      const fn = n;
      const paramHit = fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
      const nestedBody = fn.body && ts.isBlock(fn.body) ? fn.body : null;
      const declHit = nestedBody ? nameDeclaredInFunction(nestedBody, name) : false;
      if (paramHit || declHit) return;
    }
    if (ts.isIdentifier(n) && n.text === name && isValueUse(n)) {
      used = true;
      return;
    }
    if (!used) ts.forEachChild(n, visit);
  };
  visit(body);
  return used;
}

function lineIndent(source: string, pos: number): string {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const line = source.slice(lineStart, pos);
  const match = line.match(/^[ \t]*/);
  return match ? match[0] : '  ';
}

export function healUndeclaredTenantId(source: string): { code: string; changed: boolean; inserts: number } {
  const sf = ts.createSourceFile('heal.ts', source, ts.ScriptTarget.Latest, true);
  const insertAt: number[] = [];

  const visitFunctions = (node: ts.Node): void => {
    if (
      isFunctionLike(node) &&
      node.body &&
      ts.isBlock(node.body) &&
      functionIsAsync(node.body)
    ) {
      const body = node.body;
      for (const name of TENANT_NAMES) {
        if (nameUsedInFunction(body, name) && !nameDeclaredInFunction(body, name)) {
          insertAt.push(body.getStart(sf) + 1);
          break;
        }
      }
    }
    ts.forEachChild(node, visitFunctions);
  };
  visitFunctions(sf);

  if (insertAt.length === 0) {
    return { code: source, changed: false, inserts: 0 };
  }

  const unique = [...new Set(insertAt)].sort((a, b) => b - a);
  let out = source;
  for (const pos of unique) {
    // pos is just after `{`. Indent like the first statement when present.
    const afterBrace = source.slice(pos);
    const nextNonWs = afterBrace.search(/\S/);
    const indentPos = nextNonWs >= 0 ? pos + nextNonWs : pos;
    const indent = lineIndent(source, indentPos) || '  ';
    out = `${out.slice(0, pos)}\n${indent}const tenantId = await resolveEffectiveTenantId();${out.slice(pos)}`;
  }

  const importLines = out.split('\n').filter((l) => l.startsWith('import')).join('\n');
  if (!/resolveEffectiveTenantId/.test(importLines)) {
    const healSf = ts.createSourceFile('heal.ts', out, ts.ScriptTarget.Latest, true);
    const lastImport = [...healSf.statements].reverse().find((s) => ts.isImportDeclaration(s));
    const pos = lastImport ? lastImport.getEnd() : 0;
    out = `${out.slice(0, pos)}\n${IMPORT_TENANT_ID}${out.slice(pos)}`;
  }

  return { code: out, changed: true, inserts: unique.length };
}

export function parseTypecheckTenantIdFiles(tscOutput: string): string[] {
  const files = new Set<string>();
  for (const line of tscOutput.split('\n')) {
    const m = line.match(/^(\S[^(]*\.tsx?)\(\d+,\d+\):\s+error TS2304: Cannot find name '(tenantId|effectiveTenantId|__effectiveTenantId)'/);
    if (m) files.add(m[1].replace(/\\/g, '/'));
  }
  return [...files];
}

function runTsc(): string {
  try {
    execSync('npx --yes tsc --noEmit --pretty false', {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return '';
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
  }
}

function main(): void {
  const tscOut = runTsc();
  const files = parseTypecheckTenantIdFiles(tscOut);
  if (files.length === 0) {
    console.log('heal-typecheck-tenant-id: no undeclared tenantId type errors.');
    return;
  }

  let healed = 0;
  for (const rel of files) {
    const abs = join(REPO_ROOT, rel);
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      console.warn(`heal-typecheck-tenant-id: skip missing file ${rel}`);
      continue;
    }
    const { code, changed, inserts } = healUndeclaredTenantId(source);
    if (!changed) {
      console.warn(`heal-typecheck-tenant-id: ${rel} still undeclared after scan (not an async function?).`);
      continue;
    }
    writeFileSync(abs, code);
    healed += 1;
    console.log(`heal-typecheck-tenant-id: inserted ${inserts} tenantId declaration(s) in ${rel}`);
  }
  console.log(`heal-typecheck-tenant-id: healed ${healed}/${files.length} file(s).`);
}

if (process.argv[1]?.includes('heal-typecheck-tenant-id')) {
  main();
}
