import { describe, expect, it } from "vitest";
import {
  assertPatchTargets,
  assertResolvedFileContent,
  assertResolvedFileTarget,
  assertUnifiedDiffSyntax,
  decodePremiumAiContent,
  filesMentionedInDiff,
  normalizeDiffPath,
} from "./premium-ai-patch";

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

  it("rejects malformed unified diff hunk counts before git apply", () => {
    const corruptDiff = [
      "--- a/app/(builder)/ycode/api/publish/route.ts",
      "+++ b/app/(builder)/ycode/api/publish/route.ts",
      "@@ -252,6 +254,7 @@ export async function POST(request: NextRequest) {",
      " context one",
      " context two",
      " context three",
      " context four",
      " context five",
      " context six",
      "+added one",
      "+added two",
    ].join("\n");

    expect(() => assertUnifiedDiffSyntax(corruptDiff, "app/(builder)/ycode/api/publish/route.ts")).toThrow(
      "malformed hunk counts",
    );
  });

  it("accepts full-content replacements for allowed conflicted files", () => {
    expect(
      assertResolvedFileTarget(
        { filePath: "lib/page-fetcher.ts", content: "export const ok = true;\n" },
        new Set(["lib/page-fetcher.ts"]),
      ),
    ).toBe("lib/page-fetcher.ts");
  });

  it("rejects full-content replacements outside the conflicted set", () => {
    expect(() =>
      assertResolvedFileTarget(
        { filePath: "../../.env", content: "export const ok = true;\n" },
        new Set(["lib/page-fetcher.ts"]),
      ),
    ).toThrow("disallowed");
  });

  it("rejects full-content replacements that retain conflict markers", () => {
    expect(() =>
      assertResolvedFileContent({
        filePath: "lib/page-fetcher.ts",
        content: "<<<<<<< HEAD\nexport const ok = true;\n>>>>>>> branch\n",
      }),
    ).toThrow("conflict markers");
  });

  it("rejects empty or truncated full-content replacements", () => {
    expect(() =>
      assertResolvedFileContent({ filePath: "lib/page-fetcher.ts", content: "export {};" }),
    ).toThrow("empty or too short");
  });

  it("decodes base64 full-content replacements", () => {
    const content = "export const resolved = true;\n";
    expect(decodePremiumAiContent({ contentBase64: Buffer.from(content, "utf8").toString("base64") })).toBe(content);
  });
});
