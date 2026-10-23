import { hashTelemetryId as sha256 } from "@t3tools/shared/telemetryId";
import { AuthSessionId, RunId, type ApprovalReviewAuthority } from "@t3tools/contracts";
import { syntheticOriginalOrder } from "./approvalReviewTestFixtures.ts";

import { describe, expect, it } from "vite-plus/test";

import {
  canonicalReviewBundleSnapshot,
  isStructuredApprovalReviewDetail,
  parseApprovalReviewDetail,
  reviewBundleAllowsAcceptance,
  reviewBundleHasVerifiedOriginalOrder,
  reviewBundleHasVerifiedOrderChannel,
  verifyReviewBundle,
  type ReviewBundle,
} from "./approvalReview.js";

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

function withOriginal() {
  const originalOrder = syntheticOriginalOrder();
  const snapshot = {
    ...sample(),
    originalOrder,
    agentRationale: "Agent suggestion, not authorization.",
    exampleOnly: false,
    target: { label: "Synthetic target", identity: "synthetic-target" },
  };
  const bundle = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
  const authority: ApprovalReviewAuthority = {
    packageHash: bundle.hash,
    verifiedTargetId: "synthetic-target",
    expiresAt: 60_000,
    state: "pending",
    approverSessionId: AuthSessionId.make("synthetic-approver"),
    approverSubject: "synthetic-approver",
    requesterSubject: "synthetic-requester",
    workerSubject: "synthetic-worker",
    implementationSource: "never executed",
    action: {
      kind: "create_file_once",
      verifiedTargetId: "synthetic-target",
      path: "/synthetic/new.txt",
      content: "test",
      mode: 384,
      expectedAbsent: true,
      implementationVersion: "test-v1",
      implementationHash: sha256("never executed"),
    },
    originalOrder,
    agentRationale: snapshot.agentRationale,
    provenance: { status: "verified", reason: "trusted-original" },
  };
  return { bundle, authority };
}

describe("immutable original order display binding", () => {
  it("preserves Unicode, CRLF and exact UTF-16 selections without fetching a source DB", async () => {
    const { bundle, authority } = withOriginal();
    const parsed = parseApprovalReviewDetail({ approvalReview: bundle });
    if (parsed.kind !== "bundle") throw new Error("Expected immutable original");
    expect(parsed.bundle.originalOrder).toEqual(bundle.originalOrder);
    expect(Object.isFrozen(parsed.bundle.originalOrder?.receipt)).toBe(true);
    expect(await verifyReviewBundle(parsed.bundle)).toEqual({ valid: true });
    expect(reviewBundleHasVerifiedOriginalOrder(parsed.bundle, authority)).toBe(true);
  });

  it("rejects invented excerpts, changed original bytes and split surrogate selections", () => {
    const { bundle } = withOriginal();
    const order = bundle.originalOrder!;
    for (const originalOrder of [
      { ...order, excerpt: { ...order.excerpt, text: "Agent invented this" } },
      {
        ...order,
        receipt: { ...order.receipt, fullText: order.receipt.fullText.replaceAll("\r\n", "\n") },
      },
      {
        ...order,
        excerpt: {
          startUtf16: order.receipt.fullText.indexOf("🚀"),
          endUtf16: order.receipt.fullText.indexOf("🚀") + 1,
          text: "\ud83d",
        },
      },
      { ...order, receipt: { ...order.receipt, originalLink: "https://untrusted.test/source" } },
    ]) {
      expect(parseApprovalReviewDetail({ approvalReview: { ...bundle, originalOrder } }).kind).toBe(
        "invalid",
      );
    }
  });

  it("binds displayed principal, revision, lineage, receipt and rationale even after rehashing", () => {
    const { bundle, authority } = withOriginal();
    const original = bundle.originalOrder!;
    for (const receipt of [
      { ...original.receipt, principal: "forged-human" },
      { ...original.receipt, orderId: "guest-made-order" },
      { ...original.receipt, sourceEnvironmentId: original.receipt.assignment.environmentId },
      {
        ...original.receipt,
        assignment: {
          ...original.receipt.assignment,
          runId: RunId.make(original.destination.runId + "-forged"),
        },
      },
      { ...original.receipt, assignment: { ...original.receipt.assignment, acceptedSequence: 2 } },
    ]) {
      const snapshot = { ...bundle, originalOrder: { ...original, receipt } };
      const changed = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
      expect(
        reviewBundleHasVerifiedOriginalOrder(changed, { ...authority, packageHash: changed.hash }),
      ).toBe(false);
    }
    const snapshot = { ...bundle, agentRationale: "Changed justification" };
    const changed = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
    expect(
      reviewBundleHasVerifiedOriginalOrder(changed, { ...authority, packageHash: changed.hash }),
    ).toBe(false);
    expect(
      reviewBundleHasVerifiedOriginalOrder(bundle, {
        ...authority,
        provenance: { status: "unverified", reason: "untrusted-issuer" },
      }),
    ).toBe(false);
    expect(
      reviewBundleHasVerifiedOriginalOrder(bundle, { ...authority, originalOrder: undefined }),
    ).toBe(false);
    expect(reviewBundleHasVerifiedOriginalOrder(sample(), authority)).toBe(false);
  });

  it("labels a bound synthetic channel without granting human execution authority", () => {
    const { bundle, authority } = withOriginal();
    const originalOrder = {
      ...bundle.originalOrder,
      receipt: {
        ...bundle.originalOrder.receipt,
        sourceKind: "synthetic" as const,
        testOnly: true,
      },
    };
    const snapshot = { ...bundle, originalOrder };
    const testBundle = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
    const testAuthority = { ...authority, originalOrder, packageHash: testBundle.hash };
    expect(reviewBundleHasVerifiedOrderChannel(testBundle, testAuthority)).toBe(true);
    expect(reviewBundleHasVerifiedOriginalOrder(testBundle, testAuthority)).toBe(false);
  });
});

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
});
