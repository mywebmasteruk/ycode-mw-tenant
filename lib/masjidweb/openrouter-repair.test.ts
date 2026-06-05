import { describe, expect, it } from "vitest";
import {
  assertBalancedDelimiters,
  assertNoConflictMarkers,
  checkBalancedDelimiters,
  stripCodeFences,
} from "./openrouter-repair";

describe("stripCodeFences", () => {
  it("unwraps a fenced block", () => {
    expect(stripCodeFences("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("returns trimmed plain text", () => {
    expect(stripCodeFences("  hello  ")).toBe("hello");
  });
});

describe("assertNoConflictMarkers", () => {
  it("throws when markers remain", () => {
    expect(() => assertNoConflictMarkers("<<<<<<< HEAD\n", "a.ts")).toThrow(
      "conflict markers",
    );
  });

  it("passes clean content", () => {
    expect(() => assertNoConflictMarkers("export {};\n", "a.ts")).not.toThrow();
  });
});

describe("checkBalancedDelimiters", () => {
  it("flags a truncated TypeScript file (missing closing brace)", () => {
    const truncated = "export function f() {\n  if (x) {\n    return 1;\n";
    expect(checkBalancedDelimiters(truncated, "lib/a.ts")).toMatch(/unbalanced braces/);
  });

  it("passes a complete, balanced file", () => {
    const complete = "export function f() {\n  return (1 + 2);\n}\n";
    expect(checkBalancedDelimiters(complete, "lib/a.ts")).toBeNull();
  });

  it("ignores braces inside strings and comments", () => {
    const code = [
      "const open = '{';",
      "const close = \"}\";",
      "// a stray } in a comment",
      "const tpl = `value: ${open}`;",
      "export const ok = true;",
    ].join("\n");
    expect(checkBalancedDelimiters(code, "lib/a.ts")).toBeNull();
  });

  it("skips non-code files", () => {
    expect(checkBalancedDelimiters("{ unbalanced", "docs/readme.md")).toBeNull();
  });

  it("assertBalancedDelimiters throws on truncated code", () => {
    expect(() => assertBalancedDelimiters("function f() {\n", "lib/a.ts")).toThrow(
      /unbalanced/,
    );
  });
});
