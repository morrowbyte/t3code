// @effect-diagnostics nodeBuiltinImport:off - Frozen packages use deterministic SHA-256, not provider execution.
import * as NodeCrypto from "node:crypto";
import {
  type RuntimeRequestId,
  type ApprovalReviewAction,
  type ApprovalReviewOriginalOrder,
  type AuthSessionId,
  type ApprovalReviewOrderReceive,
} from "@t3tools/contracts";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const hash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

export function frozenReview(
  input: {
    readonly threadId: import("@t3tools/contracts").ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly expiresAt: number;
    readonly action: ApprovalReviewAction;
    readonly originalOrder?: ApprovalReviewOriginalOrder;
    readonly agentRationale?: string;
  },
  target: {
    readonly requesterSubject: string;
    readonly workerSubject: string;
    readonly approverSessionId: AuthSessionId;
    readonly approverSubject: string;
    readonly implementationSource: string;
    readonly verifiedTargetId: string;
  },
) {
  const inputs = canonical({
    ...input,
    requesterSubject: target.requesterSubject,
    workerSubject: target.workerSubject,
    approverSessionId: target.approverSessionId,
    approverSubject: target.approverSubject,
  });
  const snapshot = {
    schemaVersion: 1,
    ...(input.originalOrder === undefined ? {} : { originalOrder: input.originalOrder }),
    ...(input.agentRationale === undefined ? {} : { agentRationale: input.agentRationale }),
    title: "Create one new file",
    packageId: `create-file-${hash(String(input.requestId)).slice(0, 24)}`,
    version: input.action.implementationVersion,
    files: [
      { path: "request.json", content: inputs, sha256: hash(inputs), language: "json" },
      {
        path: "implementation/create_file_once.py",
        content: target.implementationSource,
        language: "python",
        sha256: hash(target.implementationSource),
      },
      {
        path: "artifact-before.txt",
        content: "",
        sha256: hash(""),
        presentation: { artifact: "new-file", role: "original" },
      },
      {
        path: "artifact-after.txt",
        content: input.action.content,
        sha256: hash(input.action.content),
        presentation: { artifact: "new-file", role: "revised" },
      },
    ],
    steps: [
      {
        id: "approval",
        title: "Approve frozen request",
        description: "A human approves this request ID and exact package hash.",
        source: { path: "request.json", line: 1 },
      },
      {
        id: "claim",
        title: "Claim once",
        description:
          "The configured worker claims the unexpired approved package for the verified target.",
      },
      {
        id: "create",
        title: "Create new file",
        description:
          "Run the included implementation with the frozen path, content and mode. Fail if the file exists.",
        source: { path: "implementation/create_file_once.py", line: 1 },
      },
      {
        id: "receipt",
        title: "Report execution",
        description: "Record the worker report. A claim alone never proves execution.",
      },
    ],
    edges: [
      { from: "approval", to: "claim" },
      { from: "claim", to: "create" },
      { from: "create", to: "receipt" },
    ],
    symbols: target.implementationSource
      .split("\n")
      .flatMap((line, index) => {
        const definition = /^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/u.exec(line);
        return definition?.[1] === undefined
          ? []
          : [{ name: definition[1], path: "implementation/create_file_once.py", line: index + 1 }];
      })
      .slice(0, 128),
    target: {
      label: target.verifiedTargetId,
      identity: target.verifiedTargetId,
      rights: ["create_file_once"],
    },
    warnings: [
      "Execution reports are worker attestations. An interrupted worker can leave the outcome unknown.",
    ],
    exampleOnly: false,
  };
  const packageHash = hash(canonical(snapshot));
  return {
    packageHash,
    prompt: JSON.stringify({ approvalReview: { ...snapshot, hash: packageHash } }),
  };
}

export function forwardedOrderText(input: ApprovalReviewOrderReceive): string {
  return `Host order ${input.orderId}, revision ${input.orderRevision}.\nUse approval_review_order for the bound request channel and approval_review_propose for each separate proposal.\nOriginal order (verbatim):\n${input.text}`;
}
