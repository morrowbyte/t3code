import {
  parseApprovalReviewDetail,
  verifyReviewBundle,
} from "../../../../packages/client-runtime/src/approvalReview.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  AuthGrantScopes,
  AuthSessionId,
  CommandId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type ApprovalReviewSubmit,
  WsRpcGroup,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
} from "@t3tools/contracts";
import { hashTelemetryId as hash } from "@t3tools/shared/telemetryId";
import * as HumanAuthority from "../auth/ApprovalReviewHumanAuthority.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ApprovalReviewService from "./ApprovalReviewService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const source = "// Reviewed create_file_once implementation fixture; never executed.\n";
const target = {
  approverSessionId: AuthSessionId.make("human-session"),
  approverSubject: "human-owner",
  verifiedTargetId: "test-host",
  requesterSubject: "vm-requester",
  workerSubject: "bounded-worker",
  allowedPath: "/tmp/review-once.txt",
  implementationVersion: "test-v1",
  implementationSource: source,
};
const decodeGrantScopes = Schema.decodeUnknownSync(AuthGrantScopes);
const database = Sqlite.layerMemory;
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "approval-review" },
  ProviderAdapterRegistry.layerFromAdapters([]),
  { databaseLayer: database, runEffectWorker: false },
);
const layerTest = ApprovalReviewService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      runtime,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
    ),
  ),
  Layer.provide(Layer.succeed(ApprovalReviewService.ApprovalReviewTargets, [target])),
);

const setup = Effect.fn("ApprovalReviewTest.setup")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("thread:approval-review");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:approval-review"),
    threadId,
    projectId: ProjectId.make("project:approval-review"),
    title: "Approval review",
    modelSelection: { instanceId: ProviderInstanceId.make("unconfigured"), model: "unused" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const input: ApprovalReviewSubmit = {
    threadId,
    submissionId: "one",
    expiresAt: DateTime.toEpochMillis(yield* DateTime.now) + 60_000,
    action: {
      kind: "create_file_once",
      verifiedTargetId: target.verifiedTargetId,
      path: target.allowedPath,
      content: "Reviewed content\n",
      mode: 384,
      expectedAbsent: true,
      implementationVersion: target.implementationVersion,
      implementationHash: hash(source),
    },
  };
  return {
    input,
    orchestrator,
    service: yield* ApprovalReviewService.ApprovalReviewService,
    projections: yield* ProjectionStore.ProjectionStoreV2,
  };
});

it.effect(
  "persists a providerless pending review, human hash approval, one claim and honest historical receipt",
  () =>
    Effect.gen(function* () {
      const { input, orchestrator, service, projections } = yield* setup();
      const submitted = yield* service.submit(input, target.requesterSubject);
      assert.deepEqual(yield* service.ready(target.workerSubject), { requests: [] });
      assert.equal((yield* service.ready("other-worker").pipe(Effect.flip)).reason, "forbidden");
      const request = yield* projections.getRuntimeRequest(input.threadId, submitted.requestId);
      assert.equal(request?.status, "pending");
      assert.equal(request?.responseCapability.type, "external");
      const context = yield* projections.getRuntimeResponseContext(
        input.threadId,
        submitted.requestId,
      );
      assert.equal(context.item?.type, "approval_request");
      if (context.item?.type !== "approval_request") return assert.fail();
      const review = parseApprovalReviewDetail(context.item.prompt);
      if (review.kind !== "bundle")
        return assert.fail("Generated review must decode in the real client parser");
      assert.deepEqual(yield* Effect.promise(() => verifyReviewBundle(review.bundle)), {
        valid: true,
      });
      assert.equal(review.bundle.hash, submitted.authority.packageHash);
      assert.equal(review.bundle.target.identity, target.verifiedTargetId);
      assert.equal(
        review.bundle.files.find((file) => file.path === "implementation/create_file_once.py")
          ?.content,
        source,
      );
      assert.equal(review.bundle.files.filter((file) => file.presentation).length, 2);
      const claim = {
        threadId: input.threadId,
        requestId: submitted.requestId,
        packageHash: submitted.authority.packageHash,
        verifiedTargetId: target.verifiedTargetId,
        claimId: "claim-one",
      };
      assert.equal(
        (yield* service.claim(claim, target.workerSubject).pipe(Effect.flip)).reason,
        "not-approved",
      );
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("human-accept"),
        threadId: input.threadId,
        requestId: submitted.requestId,
        packageHash: submitted.authority.packageHash,
        decision: "accept",
      });
      assert.equal(
        (yield* service.ready(target.workerSubject)).requests[0]?.requestId,
        submitted.requestId,
      );
      const claimed = yield* service.claim(claim, target.workerSubject);
      assert.deepEqual(yield* service.ready(target.workerSubject), { requests: [] });
      assert.equal((yield* service.read(submitted, target.workerSubject, true)).state, "claimed");
      assert.equal(claimed.state, "claimed");
      assert.isUndefined(claimed.receipt);
      assert.equal(
        (yield* service
          .receipt(
            { ...claim, receipt: { outcome: "reported_succeeded", contentHash: "0".repeat(64) } },
            target.workerSubject,
          )
          .pipe(Effect.flip)).reason,
        "invalid-receipt",
      );
      assert.equal(
        (yield* service
          .receipt(
            {
              ...claim,
              receipt: {
                outcome: "reported_succeeded",
                contentHash: hash(input.action.content),
                readback: {
                  path: "/tmp/wrong",
                  contentHash: hash(input.action.content),
                  mode: 384,
                  targetIdentity: target.verifiedTargetId,
                },
              },
            },
            target.workerSubject,
          )
          .pipe(Effect.flip)).reason,
        "invalid-receipt",
      );
      const reported = yield* service.receipt(
        {
          ...claim,
          receipt: {
            outcome: "reported_succeeded",
            contentHash: hash(input.action.content),
            readback: {
              path: input.action.path,
              contentHash: hash(input.action.content),
              mode: 384,
              uid: 1000,
              gid: 1000,
              targetIdentity: target.verifiedTargetId,
            },
          },
        },
        target.workerSubject,
      );
      assert.equal(reported.receipt?.outcome, "reported_succeeded");
      const historical = yield* projections.getRuntimeResponseContext(
        input.threadId,
        submitted.requestId,
      );
      assert.equal(
        historical.item?.type === "approval_request" && historical.item.approvalReview?.state,
        "completed",
      );
      const snapshot = yield* projections.getThreadRecords(input.threadId, [
        "runs",
        "providerSessions",
      ]);
      assert.equal(snapshot.runs.length, 0);
      assert.equal(snapshot.providerSessions.length, 0);
    }).pipe(
      Effect.provide(layerTest),
      Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
        sessionId: target.approverSessionId,
        subject: target.approverSubject,
      }),
    ),
);

it.effect(
  "rejects wrong hash, target, identity and stale approval without changing the pending request",
  () =>
    Effect.gen(function* () {
      const { input, service, orchestrator, projections } = yield* setup();
      assert.equal(
        (yield* service.submit(input, "other-requester").pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* service
          .submit(
            { ...input, action: { ...input.action, path: "/tmp/other" } },
            target.requesterSubject,
          )
          .pipe(Effect.flip)).reason,
        "invalid-action",
      );
      const submitted = yield* service.submit(input, target.requesterSubject);
      assert.equal(
        (yield* service.read(submitted, "other-requester").pipe(Effect.flip)).reason,
        "forbidden",
      );
      const respond = {
        type: "runtime-request.respond" as const,
        threadId: input.threadId,
        requestId: submitted.requestId,
        decision: "accept" as const,
      };
      const mismatch = yield* orchestrator
        .dispatch({
          ...respond,
          commandId: CommandId.make("bad-hash"),
          packageHash: "0".repeat(64),
        })
        .pipe(Effect.flip);
      assert.equal(mismatch._tag, "ApprovalReviewError");
      const broad = yield* orchestrator
        .dispatch({
          ...respond,
          commandId: CommandId.make("broad-accept"),
          packageHash: submitted.authority.packageHash,
          decision: "acceptForSession",
        })
        .pipe(Effect.flip);
      assert.equal(broad._tag, "ApprovalReviewError");
      const claim = {
        threadId: input.threadId,
        requestId: submitted.requestId,
        packageHash: submitted.authority.packageHash,
        verifiedTargetId: "wrong-target",
        claimId: "first",
      };
      assert.equal(
        (yield* service.claim(claim, target.workerSubject).pipe(Effect.flip)).reason,
        "target-mismatch",
      );
      yield* TestClock.adjust(60_001);
      const stale = yield* orchestrator
        .dispatch({
          ...respond,
          commandId: CommandId.make("stale-accept"),
          packageHash: submitted.authority.packageHash,
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "ApprovalReviewError");
      assert.equal(
        (yield* projections.getRuntimeRequest(input.threadId, submitted.requestId))?.status,
        "pending",
      );
    }).pipe(
      Effect.provide(layerTest),
      Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
        sessionId: target.approverSessionId,
        subject: target.approverSubject,
      }),
    ),
);

it.effect("serializes racing claims and makes duplicate submissions and receipts idempotent", () =>
  Effect.gen(function* () {
    const { input, service, orchestrator } = yield* setup();
    const submitted = yield* service.submit(input, target.requesterSubject);
    const duplicate = yield* service.submit(input, target.requesterSubject);
    assert.equal(duplicate.requestId, submitted.requestId);
    assert.equal(
      (yield* service
        .submit(
          { ...input, action: { ...input.action, content: "changed" } },
          target.requesterSubject,
        )
        .pipe(Effect.flip)).reason,
      "conflict",
    );
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("approve-race"),
      threadId: input.threadId,
      requestId: submitted.requestId,
      packageHash: submitted.authority.packageHash,
      decision: "accept",
    });
    const claim = {
      threadId: input.threadId,
      requestId: submitted.requestId,
      packageHash: submitted.authority.packageHash,
      verifiedTargetId: target.verifiedTargetId,
      claimId: "race",
    };
    const results = yield* Effect.all(
      [
        service.claim(claim, target.workerSubject).pipe(Effect.exit),
        service.claim({ ...claim, claimId: "racing" }, target.workerSubject).pipe(Effect.exit),
      ],
      { concurrency: 2 },
    );
    assert.equal(results.filter(Exit.isSuccess).length, 1);
    assert.equal(
      (yield* service.claim(claim, target.workerSubject).pipe(Effect.flip)).reason,
      "replayed",
    );
    const current = yield* service.read(submitted, target.requesterSubject);
    assert.isDefined(current.claimId);
    const receipt = {
      ...claim,
      claimId: current.claimId!,
      receipt: { outcome: "unknown" as const },
    };
    assert.equal(
      (yield* service.receipt(receipt, target.workerSubject)).receipt?.outcome,
      "unknown",
    );
    assert.equal(
      (yield* service.receipt(receipt, target.workerSubject)).receipt?.outcome,
      "unknown",
    );
    assert.equal(
      (yield* service
        .receipt({ ...receipt, receipt: { outcome: "reported_failed" } }, target.workerSubject)
        .pipe(Effect.flip)).reason,
      "conflict",
    );
  }).pipe(
    Effect.provide(layerTest),
    Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
      sessionId: target.approverSessionId,
      subject: target.approverSubject,
    }),
  ),
);

it.effect("never grants a rejected package", () =>
  Effect.gen(function* () {
    const { input, service, orchestrator } = yield* setup();
    const submitted = yield* service.submit(input, target.requesterSubject);
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("human-reject"),
      threadId: input.threadId,
      requestId: submitted.requestId,
      packageHash: submitted.authority.packageHash,
      decision: "decline",
    });
    assert.equal(
      (yield* service
        .claim(
          {
            threadId: input.threadId,
            requestId: submitted.requestId,
            packageHash: submitted.authority.packageHash,
            verifiedTargetId: target.verifiedTargetId,
            claimId: "rejected",
          },
          target.workerSubject,
        )
        .pipe(Effect.flip)).reason,
      "not-approved",
    );
    assert.equal(
      (yield* service.submit(input, target.requesterSubject)).authority.state,
      "rejected",
    );
  }).pipe(
    Effect.provide(layerTest),
    Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
      sessionId: target.approverSessionId,
      subject: target.approverSubject,
    }),
  ),
);

it("keeps requester/worker permissions explicitly provisioned and outside ordinary clients", () => {
  assert.notInclude(AuthStandardClientScopes, "approval-review:request");
  assert.notInclude(AuthStandardClientScopes, "approval-review:execute");
  assert.deepEqual(decodeGrantScopes(["approval-review:request"]), ["approval-review:request"]);
});

it.effect(
  "denies requester, worker and broad peer approval through authenticated RPC, accepting only the pinned human session",
  () =>
    Effect.gen(function* () {
      const { input, service, orchestrator, projections } = yield* setup();
      const submitted = yield* service.submit(input, target.requesterSubject);
      const tag = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            method,
          ): method is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, typeof tag> =>
            method !== tag,
        ),
      );
      const handler = group.toLayerHandler(tag, (command) =>
        orchestrator.dispatch(command).pipe(
          Effect.map((result) => ({ sequence: result.sequence })),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2DispatchCommandError({
                commandId: command.commandId,
                commandType: command.type,
                message: cause.message,
              }),
          ),
        ),
      );
      const attempts = [
        {
          id: "requester",
          subject: target.requesterSubject,
          scopes: ["approval-review:request"] as const,
        },
        {
          id: "worker",
          subject: target.workerSubject,
          scopes: ["approval-review:execute"] as const,
        },
        {
          id: "requester-elevated",
          subject: target.requesterSubject,
          scopes: ["orchestration:operate"] as const,
        },
        {
          id: "worker-elevated",
          subject: target.workerSubject,
          scopes: ["orchestration:operate"] as const,
        },
        { id: "peer", subject: target.approverSubject, scopes: ["orchestration:operate"] as const },
      ];
      for (const attempt of attempts) {
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              handler,
              RpcAuthorization.layer(attempt.scopes, undefined, {
                sessionId: AuthSessionId.make(attempt.id),
                subject: attempt.subject,
              }),
            ),
          ),
        );
        const result = yield* client[tag]({
          type: "runtime-request.respond",
          commandId: CommandId.make(`deny:${attempt.id}`),
          threadId: input.threadId,
          requestId: submitted.requestId,
          packageHash: submitted.authority.packageHash,
          decision: "accept",
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result), attempt.id);
        assert.equal(
          (yield* projections.getRuntimeRequest(input.threadId, submitted.requestId))?.status,
          "pending",
        );
      }
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            handler,
            RpcAuthorization.layer(["orchestration:operate"], undefined, {
              sessionId: target.approverSessionId,
              subject: target.approverSubject,
            }),
          ),
        ),
      );
      yield* client[tag]({
        type: "runtime-request.respond",
        commandId: CommandId.make("pinned-human"),
        threadId: input.threadId,
        requestId: submitted.requestId,
        packageHash: submitted.authority.packageHash,
        decision: "accept",
      });
      assert.equal(
        (yield* projections.getRuntimeRequest(input.threadId, submitted.requestId))?.approvalReview
          ?.state,
        "approved",
      );
    }).pipe(Effect.provide(layerTest)),
);
