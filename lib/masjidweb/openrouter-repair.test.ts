import { describe, expect, it } from "vitest";
import {
  assertBalancedDelimiters,
  assertNoConflictMarkers,
  checkBalancedDelimiters,
  isLatestClaudeFrontierDirective,
  isValidOpenRouterModelId,
  parseClaudeVersion,
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

  it("picks the newest point release, not the highest hardcoded bonus (regression: 4.8 > 4.5)", () => {
    // The old bonus table gave 4.5 a higher score than 4.6/4.7/4.8 because it had
    // no rule above 4.5. The version-parsing ranker must pick the genuine latest.
    expect(
      selectLatestClaudeFrontierModel([
        { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", created: 100 },
        { id: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1", created: 90 },
        { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8", created: 110 },
        { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7", created: 105 },
        { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", created: 108 },
      ]),
    ).toBe("anthropic/claude-opus-4.8");
  });

  it("prefers the canonical slug over -fast / variant slugs on a version tie", () => {
    expect(
      selectLatestClaudeFrontierModel([
        { id: "anthropic/claude-opus-4.8-fast", name: "Claude Opus 4.8 (fast)", created: 200 },
        { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8", created: 200 },
      ]),
    ).toBe("anthropic/claude-opus-4.8");
  });

  it("excludes Haiku and non-Claude models from frontier selection", () => {
    expect(
      selectLatestClaudeFrontierModel([
        { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", created: 999 },
        { id: "openai/gpt-5", name: "GPT-5", created: 999 },
      ]),
    ).toBeNull();
  });

  it("parseClaudeVersion handles both slug orderings and ignores dates", () => {
    expect(parseClaudeVersion("anthropic/claude-opus-4.8")).toBe(4.8);
    expect(parseClaudeVersion("anthropic/claude-3.5-sonnet")).toBe(3.5);
    expect(parseClaudeVersion("anthropic/claude-opus-4")).toBe(4);
    expect(parseClaudeVersion("anthropic/claude-opus-4.1-20260101")).toBe(4.1);
  });
});
