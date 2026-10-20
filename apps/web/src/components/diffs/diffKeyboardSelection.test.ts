import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";
import { firstDiffSelection, moveDiffSelection } from "./diffKeyboardSelection";

const patch =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n@@ -10,2 +10,2 @@\n-other\n+next\n last\n";
const fileDiff = parsePatchFiles(patch)[0]!.files[0]!;
const files = [
  { fileKey: "a", fileDiff },
  { fileKey: "b", fileDiff },
];

describe("diff keyboard selection", () => {
  it("crosses collapsed hunk gaps and extends a real line selection", () => {
    const first = firstDiffSelection(files[0]);
    expect(first?.range).toEqual({ start: 1, end: 1, side: "additions" });
    const second = moveDiffSelection(files, first, "j", true);
    expect(second?.range).toEqual({ start: 1, end: 2, side: "additions" });
    const next = moveDiffSelection(files, second, "j", false);
    expect(next?.range.end).toBe(10);
    expect(moveDiffSelection(files, next, "k", false)?.range.end).toBe(2);
    expect(moveDiffSelection(files, first, "]", false)?.range.end).toBe(10);
    expect(moveDiffSelection(files, next, "[", false)?.range.end).toBe(1);
  });
  it("switches files and preserves deleted-only ranges", () => {
    expect(moveDiffSelection(files, firstDiffSelection(files[0]), "}", false)?.id).toBe("b");
    const removed = parsePatchFiles(
      "diff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -4,2 +3,0 @@\n-old\n-more\n",
    )[0]!.files[0]!;
    const deleted = [{ fileKey: "gone", fileDiff: removed }];
    const first = firstDiffSelection(deleted[0]);
    expect(first?.range).toEqual({ start: 4, end: 4, side: "deletions" });
    expect(moveDiffSelection(deleted, first, "l", false)).toEqual(first);
    expect(moveDiffSelection(deleted, first, "j", false)?.range.end).toBe(5);
  });
});
