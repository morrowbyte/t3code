import { describe, expect, it } from "vite-plus/test";
import { batchCheckArguments } from "./check-changed-args.ts";

describe("changed-file check arguments", () => {
  it.each([undefined, 37])(
    "keeps changed files within command-line and file-count limits (%s)",
    (maxFiles) => {
      const prefix = ["test", "run", "--passWithNoTests"];
      const files = Array.from(
        { length: 900 },
        (_, index) => `packages/example/src/${"long-path-".repeat(12)}${index}.test.ts`,
      );
      const batches = batchCheckArguments(prefix, files, maxFiles);
      expect(batches.length).toBeGreaterThan(1);
      for (const batch of batches) {
        expect(batch.slice(0, prefix.length)).toEqual(prefix);
        expect(
          batch.reduce((size, argument) => size + argument.length * 2 + 3, 0),
        ).toBeLessThanOrEqual(24_000);
        if (maxFiles !== undefined)
          expect(batch.length - prefix.length).toBeLessThanOrEqual(maxFiles);
      }
      expect(batches.flatMap((batch) => batch.slice(prefix.length))).toEqual(files);
    },
  );

  it("preserves literal Unicode, spaces and shell characters", () => {
    const files = ["src/über etwas.ts", "src/$() and `literal`.ts", 'src/quote".ts'];
    expect(batchCheckArguments(["fmt", "--check"], files)).toEqual([["fmt", "--check", ...files]]);
  });
});
