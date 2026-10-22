// @effect-diagnostics nodeBuiltinImport:off - Frozen review hashes and receipt IDs use Node cryptography without an executor or provider runtime.
import * as NodeCrypto from "node:crypto";
import {
  ApprovalReviewError,
  ApprovalReviewSubmit,
  ApprovalReviewClaim,
  ApprovalReviewReport,
  type ApprovalReviewReady,
  OrchestrationV2RuntimeRequestJson,
  ApprovalReviewAuthority,
  AuthSessionId,
  CommandId,
  NodeId,
  TurnItemId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const Target = Schema.Struct({
  verifiedTargetId: Schema.String,
  approverSessionId: AuthSessionId,
  approverSubject: Schema.String,
  requesterSubject: Schema.String,
  workerSubject: Schema.String,
  allowedPath: Schema.String,
  implementationVersion: Schema.String,
  implementationSource: Schema.String.check(Schema.isMaxLength(65_536)),
});

export class ApprovalReviewTargets extends Context.Reference<readonly (typeof Target.Type)[]>(
  "t3/ApprovalReviewTargets",
  { defaultValue: () => [] },
) {}

// Deliberately absent from normal client scopes; only explicitly provisioned identities use it.
export const layerTargets = Layer.effect(
  ApprovalReviewTargets,
  Effect.gen(function* () {
    const json = yield* Config.String("T3CODE_APPROVAL_REVIEW_TARGETS").pipe(
      Config.withDefault("[]"),
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Target).check(Schema.isMaxLength(16))),
    )(json);
  }),
);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

function frozenReview(
  input: Omit<ApprovalReviewSubmit, "submissionId"> & { readonly requestId: RuntimeRequestId },
  target: typeof Target.Type,
) {
  const inputs = JSON.stringify(
    {
      ...input,
      requesterSubject: target.requesterSubject,
      workerSubject: target.workerSubject,
      approverSessionId: target.approverSessionId,
      approverSubject: target.approverSubject,
    },
    null,
    2,
  );
  const snapshot = {
    schemaVersion: 1,
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

export class ApprovalReviewService extends Context.Service<
  ApprovalReviewService,
  {
    readonly ready: (subject: string) => Effect.Effect<ApprovalReviewReady, ApprovalReviewError>;
    readonly submit: (
      input: ApprovalReviewSubmit,
      subject: string,
    ) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly requestId: RuntimeRequestId;
        readonly authority: ApprovalReviewAuthority;
      },
      ApprovalReviewError
    >;
    readonly read: (
      input: { readonly threadId: ThreadId; readonly requestId: RuntimeRequestId },
      subject: string,
      worker?: boolean,
    ) => Effect.Effect<ApprovalReviewAuthority, ApprovalReviewError>;
    readonly claim: (
      input: ApprovalReviewClaim,
      subject: string,
    ) => Effect.Effect<ApprovalReviewAuthority, ApprovalReviewError>;
    readonly receipt: (
      input: ApprovalReviewReport,
      subject: string,
    ) => Effect.Effect<ApprovalReviewAuthority, ApprovalReviewError>;
  }
>()("t3/orchestration-v2/ApprovalReviewService") {}

const decodeSubmit = Schema.decodeUnknownEffect(ApprovalReviewSubmit);
const decodeAuthority = Schema.decodeUnknownEffect(ApprovalReviewAuthority);
const decodeRuntimeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJson),
);

const make = Effect.gen(function* () {
  const targets = yield* ApprovalReviewTargets;
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const dispatch = Effect.fn("ApprovalReviewService.dispatch")(function* (
    command: Parameters<typeof orchestrator.dispatch>[0],
  ) {
    return yield* orchestrator
      .dispatch(command)
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ApprovalReviewError"
            ? cause
            : new ApprovalReviewError({ reason: "storage" }),
        ),
      );
  });
  const read = Effect.fn("ApprovalReviewService.read")(function* (
    input: { readonly threadId: ThreadId; readonly requestId: RuntimeRequestId },
    subject: string,
    worker = false,
  ) {
    if (targets.length === 0) return yield* new ApprovalReviewError({ reason: "disabled" });
    const request = yield* projections
      .getRuntimeRequest(input.threadId, input.requestId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    const authority = request?.approvalReview;
    if (request?.responseCapability.type !== "external" || authority === undefined)
      return yield* new ApprovalReviewError({ reason: "missing" });
    if ((worker ? authority.workerSubject : authority.requesterSubject) !== subject)
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    if (
      !targets.some(
        (target) =>
          target.verifiedTargetId === authority.verifiedTargetId &&
          target.workerSubject === authority.workerSubject &&
          target.requesterSubject === authority.requesterSubject &&
          target.approverSessionId === authority.approverSessionId &&
          target.approverSubject === authority.approverSubject &&
          target.allowedPath === authority.action.path &&
          target.implementationVersion === authority.action.implementationVersion &&
          target.implementationSource === authority.implementationSource &&
          hash(target.implementationSource) === authority.action.implementationHash,
      )
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    return authority;
  });
  const submit = Effect.fn("ApprovalReviewService.submit")(function* (
    raw: ApprovalReviewSubmit,
    subject: string,
  ) {
    const decoded = yield* decodeSubmit(raw, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "invalid-action" })));
    const { submissionId, ...fields } = decoded;
    const input = {
      ...fields,
      action: Object.freeze({ ...fields.action }),
      requestId: RuntimeRequestId.make(
        `approval-review:${hash(canonical([fields.threadId, subject, submissionId]))}`,
      ),
    };
    if (targets.length === 0) return yield* new ApprovalReviewError({ reason: "disabled" });
    const target = targets.find(
      (target) =>
        target.verifiedTargetId === input.action.verifiedTargetId &&
        target.requesterSubject === subject,
    );
    if (target === undefined) return yield* new ApprovalReviewError({ reason: "forbidden" });
    // Exact configured paths keep this first operation bounded; no path-prefix or shell parsing.
    if (
      input.action.path !== target.allowedPath ||
      input.action.path.includes("\0") ||
      !input.action.content.isWellFormed() ||
      !target.implementationSource.isWellFormed() ||
      target.implementationSource.length === 0 ||
      input.action.implementationVersion !== target.implementationVersion ||
      input.action.implementationHash !== hash(target.implementationSource)
    )
      return yield* new ApprovalReviewError({ reason: "invalid-action" });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (input.expiresAt <= now || input.expiresAt > now + 3_600_000)
      return yield* new ApprovalReviewError({ reason: "expired" });
    const review = frozenReview(input, target);
    const authority = yield* decodeAuthority({
      packageHash: review.packageHash,
      verifiedTargetId: target.verifiedTargetId,
      expiresAt: input.expiresAt,
      state: "pending",
      approverSessionId: target.approverSessionId,
      approverSubject: target.approverSubject,
      requesterSubject: subject,
      workerSubject: target.workerSubject,
      action: input.action,
      implementationSource: target.implementationSource,
    }).pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "invalid-action" })));
    yield* dispatch({
      type: "approval-review.submit",
      commandId: CommandId.make(`approval-submit:${NodeCrypto.randomUUID()}`),
      threadId: input.threadId,
      requestId: input.requestId,
      nodeId: NodeId.make(`approval-review:${input.requestId}`),
      turnItemId: TurnItemId.make(`approval-review:${input.requestId}`),
      authority,
      prompt: review.prompt,
    });
    return {
      threadId: input.threadId,
      requestId: input.requestId,
      authority: yield* read(input, subject),
    };
  });
  const ready = Effect.fn("ApprovalReviewService.ready")(function* (subject: string) {
    if (targets.length === 0) return yield* new ApprovalReviewError({ reason: "disabled" });
    const configured = targets.filter((target) => target.workerSubject === subject);
    if (configured.length === 0) return yield* new ApprovalReviewError({ reason: "forbidden" });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const requests: ApprovalReviewReady["requests"][number][] = [];
    for (const target of configured) {
      const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_runtime_requests
        WHERE status = 'resolved' AND json_extract(payload_json, '$.approvalReview.state') = 'approved'
          AND json_extract(payload_json, '$.approvalReview.workerSubject') = ${subject}
          AND json_extract(payload_json, '$.approvalReview.verifiedTargetId') = ${target.verifiedTargetId}
          AND json_extract(payload_json, '$.approvalReview.expiresAt') > ${now}
          AND json_extract(payload_json, '$.approvalReview.approverSessionId') = ${target.approverSessionId}
          AND json_extract(payload_json, '$.approvalReview.approverSubject') = ${target.approverSubject}
          AND json_extract(payload_json, '$.approvalReview.requesterSubject') = ${target.requesterSubject}
          AND json_extract(payload_json, '$.approvalReview.action.path') = ${target.allowedPath}
          AND json_extract(payload_json, '$.approvalReview.action.implementationVersion') = ${target.implementationVersion}
          AND json_extract(payload_json, '$.approvalReview.implementationSource') = ${target.implementationSource}
        ORDER BY created_at ASC, runtime_request_id ASC LIMIT 10
      `.pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
      for (const row of rows) {
        const request = yield* decodeRuntimeRequest(row.payload_json).pipe(
          Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })),
        );
        if (
          request.responseCapability.type !== "external" ||
          request.decision !== "accept" ||
          request.approvalReview === undefined
        )
          continue;
        requests.push({
          threadId: ThreadId.make(row.thread_id),
          requestId: request.id,
          packageHash: request.approvalReview.packageHash,
          verifiedTargetId: target.verifiedTargetId,
        });
        if (requests.length === 10) return { requests };
      }
    }
    return { requests };
  });
  const claim = Effect.fn("ApprovalReviewService.claim")(function* (
    input: ApprovalReviewClaim,
    subject: string,
  ) {
    yield* read(input, subject, true);
    yield* dispatch({
      ...input,
      type: "approval-review.claim",
      commandId: CommandId.make(`approval-claim:${NodeCrypto.randomUUID()}`),
      workerSubject: subject,
    });
    return yield* read(input, subject, true);
  });
  const receipt = Effect.fn("ApprovalReviewService.receipt")(function* (
    input: ApprovalReviewReport,
    subject: string,
  ) {
    yield* read(input, subject, true);
    yield* dispatch({
      ...input,
      type: "approval-review.receipt",
      commandId: CommandId.make(`approval-receipt:${NodeCrypto.randomUUID()}`),
      workerSubject: subject,
    });
    return yield* read(input, subject, true);
  });
  return ApprovalReviewService.of({ submit, read, claim, receipt, ready });
});

export const layer = Layer.effect(ApprovalReviewService, make);
