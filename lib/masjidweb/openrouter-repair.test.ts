import { describe, expect, it } from "vitest";
import { assertNoConflictMarkers, stripCodeFences } from "./openrouter-repair";

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
