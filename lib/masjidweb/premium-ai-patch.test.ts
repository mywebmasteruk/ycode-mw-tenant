import { describe, expect, it } from "vitest";
import { assertPatchTargets, filesMentionedInDiff, normalizeDiffPath } from "./premium-ai-patch";

describe("Premium AI patch validation", () => {
  it("extracts allowed paths from unified diffs", () => {
    const diff = [
      "--- a/lib/page-fetcher.ts",
      "+++ b/lib/page-fetcher.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(filesMentionedInDiff(diff)).toEqual(["lib/page-fetcher.ts"]);
  });

  it("rejects dangerous diff paths", () => {
    expect(normalizeDiffPath("../../.env")).toBeNull();
    expect(normalizeDiffPath("a/node_modules/pkg/index.js")).toBeNull();
    expect(normalizeDiffPath("b/.git/config")).toBeNull();
  });

  it("rejects diffs that target files outside the conflicted set", () => {
    const diff = [
      "--- a/lib/page-fetcher.ts",
      "+++ b/lib/page-fetcher.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(() =>
      assertPatchTargets(
        { filePath: "lib/page-fetcher.ts", unifiedDiff: diff },
        new Set(["lib/repositories/pageRepository.ts"]),
      ),
    ).toThrow("disallowed");
  });
});
