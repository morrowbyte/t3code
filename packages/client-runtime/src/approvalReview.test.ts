// @effect-diagnostics nodeBuiltinImport:off -- Independent byte/hash oracle and on-disk fixture boundary, outside an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  canonicalReviewBundleSnapshot,
  isStructuredApprovalReviewDetail,
  parseApprovalReviewDetail,
  reviewBundleAllowsAcceptance,
  verifyReviewBundle,
  type ReviewBundle,
} from "./approvalReview.js";

const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

function sample(): ReviewBundle {
  const data = {
    schemaVersion: 1 as const,
    title: "Review example",
    packageId: "example",
    version: "1",
    files: [
      {
        path: "src/main.py",
        content: "print('€')\r\n",
        sha256: sha256("print('€')\r\n"),
        language: "python",
      },
    ],
    steps: [
      {
        id: "start",
        title: "Start",
        description: "Read source",
        source: { path: "src/main.py", line: 1 },
      },
    ],
    edges: [],
    symbols: [{ name: "main", path: "src/main.py", line: 1 }],
    target: { label: "Example target", rights: ["root"] },
    warnings: ["No backend approval authority"],
    exampleOnly: true,
  };
  return { ...data, hash: sha256(canonicalReviewBundleSnapshot(data)) };
}

describe("approval review bundles", () => {
  it("preserves ordinary unstructured requests", () => {
    for (const detail of [
      undefined,
      null,
      "Run the command?",
      "{}",
      {},
      { note: "approvalReview" },
    ]) {
      expect(parseApprovalReviewDetail(detail)).toEqual({ kind: "none" });
    }
  });

  it("recognizes an envelope and produces an immutable independent snapshot", async () => {
    const original = sample();
    const result = parseApprovalReviewDetail({ approvalReview: original });
    expect(result.kind).toBe("bundle");
    if (result.kind !== "bundle") throw new Error("Expected bundle");
    expect(result.bundle).not.toBe(original);
    expect(Object.isFrozen(result.bundle.files[0])).toBe(true);
    expect(await verifyReviewBundle(result.bundle)).toEqual({ valid: true });
    expect(parseApprovalReviewDetail(JSON.stringify({ approvalReview: original }))).toEqual(result);
  });

  it("never falls back to ordinary approval for a malformed review envelope", () => {
    const invalid = [
      '{"approvalReview":',
      '{"approvalReview": {broken}}',
      "{approvalReview: null}",
      { approvalReview: null },
      { approvalReview: "text" },
      { approvalReview: sample(), other: true },
      { approvalReview: { ...sample(), schemaVersion: 2 } },
      { approvalReview: { ...sample(), hash: "not-a-hash" } },
    ];
    for (const detail of invalid) {
      expect(parseApprovalReviewDetail(detail).kind).toBe("invalid");
      expect(isStructuredApprovalReviewDetail(detail)).toBe(true);
    }
  });

  it("checks exact UTF-8 bytes, including newline changes", async () => {
    const bundle = sample();
    expect(await verifyReviewBundle(bundle)).toEqual({ valid: true });
    for (const content of ["print('€')\n", "print('x')\r\n"]) {
      const changed = { ...bundle, files: [{ ...bundle.files[0]!, content }] };
      expect(await verifyReviewBundle(changed)).toEqual({
        valid: false,
        error: "File SHA-256 mismatch: src/main.py",
      });
    }
    const content = "print('changed')\r\n";
    expect(
      await verifyReviewBundle({
        ...bundle,
        files: [{ ...bundle.files[0]!, content, sha256: sha256(content) }],
      }),
    ).toEqual({ valid: false, error: "Package SHA-256 mismatch" });
  });

  it("binds metadata and package hash while ignoring only the top-level hash field", async () => {
    const bundle = sample();
    expect(await verifyReviewBundle({ ...bundle, hash: "0".repeat(64) })).toEqual({
      valid: false,
      error: "Package SHA-256 mismatch",
    });
    expect(await verifyReviewBundle({ ...bundle, target: { label: "Another host" } })).toEqual({
      valid: false,
      error: "Package SHA-256 mismatch",
    });
    expect(canonicalReviewBundleSnapshot(bundle)).toContain(bundle.files[0]!.sha256);
    expect(canonicalReviewBundleSnapshot({ ...bundle, hash: "f".repeat(64) } as ReviewBundle)).toBe(
      canonicalReviewBundleSnapshot(bundle),
    );
    const reordered = Object.fromEntries(
      Object.entries(bundle).toReversed(),
    ) as unknown as ReviewBundle;
    expect(await verifyReviewBundle(reordered)).toEqual({ valid: true });
  });

  it("rejects unsafe and duplicate paths, unknown fields, and invalid Unicode", () => {
    const bundle = sample();
    const badFiles = [
      [{ ...bundle.files[0]!, path: "../main.py" }],
      [{ ...bundle.files[0]!, path: "/main.py" }],
      [{ ...bundle.files[0]!, path: "src\\main.py" }],
      [{ ...bundle.files[0]!, path: "src/%2e/main.py" }],
      [bundle.files[0], bundle.files[0]],
      [{ ...bundle.files[0]!, content: "\ud800" }],
      [{ ...bundle.files[0]!, extra: "unbound" }],
    ];
    for (const files of badFiles)
      expect(parseApprovalReviewDetail({ approvalReview: { ...bundle, files } }).kind).toBe(
        "invalid",
      );
  });

  it("validates source files, step and symbol line ranges, edges and uniqueness", () => {
    const bundle = sample();
    const invalid = [
      { steps: [{ ...bundle.steps[0], source: { path: "absent.py", line: 1 } }] },
      { steps: [{ ...bundle.steps[0], source: { path: "src/main.py", line: 0 } }] },
      { steps: [{ ...bundle.steps[0], source: { path: "src/main.py", line: 1, endLine: 2 } }] },
      { steps: [{ ...bundle.steps[0], source: { path: "src/main.py", line: 1, endLine: 0 } }] },
      { steps: [bundle.steps[0], bundle.steps[0]] },
      { edges: [{ from: "start", to: "missing" }] },
      { symbols: [{ name: "bad", path: "src/main.py", line: 2 }] },
      { symbols: [bundle.symbols[0], bundle.symbols[0]] },
    ];
    for (const change of invalid)
      expect(parseApprovalReviewDetail({ approvalReview: { ...bundle, ...change } }).kind).toBe(
        "invalid",
      );
  });

  it("bounds object and serialized payloads before rendering or verification", () => {
    const bundle = sample();
    const sparseFiles = [bundle.files[0]];
    Reflect.deleteProperty(sparseFiles, "0");
    expect(
      parseApprovalReviewDetail({ approvalReview: { ...bundle, files: sparseFiles } }).kind,
    ).toBe("invalid");
    expect(
      parseApprovalReviewDetail({
        approvalReview: { ...bundle, files: Array.from({ length: 65 }, () => bundle.files[0]) },
      }).kind,
    ).toBe("invalid");
    expect(
      parseApprovalReviewDetail({
        approvalReview: {
          ...bundle,
          files: [{ ...bundle.files[0], content: "x".repeat(1024 * 1024 + 1) }],
        },
      }).kind,
    ).toBe("invalid");
    expect(parseApprovalReviewDetail('{"approvalReview":' + " ".repeat(2 * 1024 * 1024)).kind).toBe(
      "invalid",
    );
  });

  it("blocks acceptance for examples and every untrusted live bundle", async () => {
    for (const exampleOnly of [true, false]) {
      const bundle = { ...sample(), exampleOnly };
      const signed = { ...bundle, hash: sha256(canonicalReviewBundleSnapshot(bundle)) };
      expect(await verifyReviewBundle(signed)).toEqual({ valid: true });
      expect(reviewBundleAllowsAcceptance(signed)).toBe(false);
    }
  });

  it("ships all eight exact original files and a verifiable AST-indexed example", async () => {
    const folder = new URL(
      "../../../apps/web/src/components/approvalReview/fixtures/gitlab/",
      import.meta.url,
    );
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
    const { gitlabExampleBundle } =
      await import("../../../apps/web/src/components/approvalReview/gitlabExample.js");
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
