// @effect-diagnostics nodeBuiltinImport:off -- Independent byte/hash oracle and on-disk fixture boundary, outside an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import {
  canonicalReviewBundleSnapshot,
  verifyReviewBundle,
  type ReviewBundle,
} from "@t3tools/client-runtime/approvalReview";
import { describe, expect, it } from "vite-plus/test";

import { gitlabExampleBundle } from "./gitlabExample.js";

describe("GitLab approval review example", () => {
  it("ships all eight exact original files and a verifiable AST-indexed example", async () => {
    const folder = new URL("./fixtures/gitlab/", import.meta.url);
    const metadata = JSON.parse(
      NodeFS.readFileSync(new URL("bundle.metadata.json", folder), "utf8"),
    ) as Omit<ReviewBundle, "files"> & {
      files: readonly Omit<ReviewBundle["files"][number], "content">[];
    };
    expect(
      NodeFS.readdirSync(folder).filter((name) => name !== "bundle.metadata.json"),
    ).toHaveLength(8);
    const bundle = {
      ...metadata,
      files: metadata.files.map((file) => ({
        ...file,
        content: NodeFS.readFileSync(new URL(file.path, folder), "utf8"),
      })),
    };
    expect(await verifyReviewBundle(bundle)).toEqual({ valid: true });
    for (const file of bundle.files) {
      expect(NodeCrypto.createHash("sha256").update(file.content, "utf8").digest("hex")).toBe(
        file.sha256,
      );
    }
    expect(
      NodeCrypto.createHash("sha256")
        .update(canonicalReviewBundleSnapshot(bundle), "utf8")
        .digest("hex"),
    ).toBe(bundle.hash);
    expect(bundle.hash).toBe("a3b12cc4ef941515faa8b675c06697ffcc0dc17824be720b9f45a98918d34133");
    expect(gitlabExampleBundle).toEqual(bundle);
    expect(await verifyReviewBundle(gitlabExampleBundle)).toEqual({ valid: true });
    expect(
      bundle.symbols.some(
        (symbol) => symbol.name === "Change.backup_directory" && symbol.line === 49,
      ),
    ).toBe(true);
    const review = JSON.parse(
      bundle.files.find((file) => file.path === "review.json")!.content,
    ) as {
      steps: readonly { function: string; line: number; source: string }[];
    };
    const sourceLines = bundle.files
      .find((file) => file.path === "upgrade.py")!
      .content.split("\n");
    for (const step of review.steps) {
      const symbol = bundle.symbols.find((entry) => entry.name === step.function)!;
      expect(symbol.line).toBe(step.line);
      expect(sourceLines.slice(symbol.line - 1, symbol.endLine).join("\n") + "\n").toBe(
        step.source,
      );
    }
    expect(bundle.steps.some((step) => step.kind === "fork" || step.kind === "join")).toBe(false);
    expect(bundle.edges.some((edge) => edge.to === "stopped" && edge.label === "Fehler")).toBe(
      true,
    );
  });
});
