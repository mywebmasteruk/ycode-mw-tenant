import { describe, expect, it } from "vitest";
import {
  assertBalancedDelimiters,
  assertNoConflictMarkers,
  checkBalancedDelimiters,
  isLatestClaudeFrontierDirective,
  isValidOpenRouterModelId,
  selectLatestClaudeFrontierModel,
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

describe("OpenRouter model selection", () => {
  it("accepts OpenRouter model IDs and the latest Claude directive", () => {
    expect(isValidOpenRouterModelId("anthropic/claude-opus-4.1")).toBe(true);
    expect(isValidOpenRouterModelId("Anthropic: Claude Opus")).toBe(false);
    expect(isLatestClaudeFrontierDirective("latest_claude_frontier")).toBe(true);
  });

  it("prefers the latest Claude Opus/Sonnet frontier model", () => {
    expect(
      selectLatestClaudeFrontierModel([
        { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", created: 1 },
        { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", created: 2 },
        { id: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1", created: 3 },
        { id: "google/gemini-2.5-pro", name: "Gemini", created: 4 },
      ]),
    ).toBe("anthropic/claude-opus-4.1");
  });
});
