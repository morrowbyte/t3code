import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ApprovalReviewError,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ApprovalReviewSubmit,
  ApprovalReviewOriginalOrder,
  type ApprovalReviewOrderReceive,
  type EnvironmentSessionPrincipalShape,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HumanAuthority from "../auth/ApprovalReviewHumanAuthority.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as Projections from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as Replay from "./testkit/ProviderReplayHarness.ts";
import * as HostOrders from "./ApprovalReviewHostOrders.ts";
import * as Receiver from "./ApprovalReviewOrderReceiver.ts";
import * as Forward from "./ApprovalReviewOrderForward.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";
import * as Provenance from "./ApprovalReviewProvenance.ts";
import * as Service from "./ApprovalReviewService.ts";
import { hash, forwardedOrderText } from "./ApprovalReviewPackage.ts";
import {
  parseApprovalReviewDetail,
  verifyReviewBundle,
} from "../../../../packages/client-runtime/src/approvalReview.ts";

const hostEnvironmentId = EnvironmentId.make("host-environment");
const vmEnvironmentId = EnvironmentId.make("paired-vm-environment");
const hostThreadId = ThreadId.make("host-control-thread");
const vmThreadId = ThreadId.make("vm-task-thread");
const human: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("qualified-ui"),
  subject: "owner",
  method: "browser-session-cookie",
  scopes: new Set<AuthEnvironmentScope>(["orchestration:read", "orchestration:operate"]),
};
const vmActor: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("vm-paired-session"),
  subject: "vm-requester",
  method: "dpop-access-token",
  proofKeyThumbprint: "v".repeat(43),
  scopes: new Set<AuthEnvironmentScope>(["approval-review:request"]),
};
const hostSender: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("host-sender"),
  subject: "host-forward",
  method: "dpop-access-token",
  proofKeyThumbprint: "h".repeat(43),
  scopes: new Set<AuthEnvironmentScope>(["orchestration:operate"]),
};
const target = {
  verifiedTargetId: "bounded-target",
  approverSessionId: human.sessionId,
  approverSubject: human.subject,
  requesterSubject: vmActor.subject,
  workerSubject: "worker",
  allowedPath: "/tmp/review-new.txt",
  implementationVersion: "v1",
  implementationSource: "# reviewed fixture; never executed\n",
};
const channel: Policy.PairedVm = {
  hostThreadId,
  vmId: "paired-vm",
  label: "Paired VM",
  environmentId: vmEnvironmentId,
  threadId: vmThreadId,
  sessionId: vmActor.sessionId,
  subject: vmActor.subject,
  proofKeyThumbprint: vmActor.proofKeyThumbprint!,
  forward: {
    proofKeySecretName: "existing-forward-key",
    credentialSecretName: "existing-forward-token",
    sessionId: hostSender.sessionId,
    subject: hostSender.subject,
  },
};
const originalText = "Erstelle die freigegebene Datei.\r\nExakter Auftrag: 😀  unverändert.\r\n";
const adapter = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider is started in host-order tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

// These in-memory unit fixtures model provisioned policies; no browser/session/key is provisioned.
function scenario(
  options: {
    readonly synthetic?: boolean;
    readonly loseAck?: boolean;
    readonly beforeAck?: Effect.Effect<void>;
  } = {},
) {
  const synthetic = options.synthetic ?? true;
  const calls: ApprovalReviewOrderReceive[] = [];
  const database = Sqlite.layerMemory;
  const infrastructure = Layer.mergeAll(
    database,
    ThreadCommandExecutor.layer,
    Projections.layer.pipe(Layer.provide(database)),
    Replay.layerWithRegistry(
      { name: "host-order-channel" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
  const policyValue = {
    humans: [
      synthetic
        ? {
            sessionId: human.sessionId,
            subject: human.subject,
            sourceKind: "synthetic" as const,
            testOnly: true as const,
          }
        : {
            sessionId: human.sessionId,
            subject: human.subject,
            sourceKind: "human" as const,
            testOnly: false as const,
          },
    ],
    channels: [
      channel,
      {
        ...channel,
        vmId: "other-vm",
        sessionId: AuthSessionId.make("other-paired-vm"),
        subject: "other-vm",
      },
    ],
    receiver: {
      sessionId: hostSender.sessionId,
      subject: hostSender.subject,
      proofKeyThumbprint: hostSender.proofKeyThumbprint!,
      threadId: vmThreadId,
      testOnly: synthetic,
    },
  };
  const policyLayer = Layer.succeed(Policy.ApprovalReviewOrderPolicy, policyValue);
  const receiverLayer = Receiver.layer.pipe(
    Layer.provide(infrastructure),
    Layer.provide(policyLayer),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(vmEnvironmentId),
      }),
    ),
  );
  const forwardLayer = Layer.effect(
    Forward.ApprovalReviewOrderForward,
    Effect.gen(function* () {
      const receiver = yield* Receiver.ApprovalReviewOrderReceiver;
      return Forward.ApprovalReviewOrderForward.of({
        ready: () => Effect.succeed(true),
        send: (destination, input) =>
          Effect.gen(function* () {
            assert.equal(destination.environmentId, vmEnvironmentId);
            calls.push(input);
            const ack = yield* receiver.receive(input, hostSender);
            if (options.beforeAck) yield* options.beforeAck;
            if (options.loseAck)
              return yield* new ApprovalReviewError({ reason: "forward-unknown" });
            return ack;
          }),
        readOrder: () => Effect.die("Agent outbound is covered by its own boundary tests"),
        propose: () => Effect.die("Agent outbound is covered by its own boundary tests"),
      });
    }),
  ).pipe(Layer.provide(receiverLayer));
  const hostOrders = HostOrders.layer.pipe(
    Layer.provide(infrastructure),
    Layer.provide(policyLayer),
    Layer.provide(forwardLayer),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(hostEnvironmentId),
      }),
    ),
  );
  const layer = Service.layer.pipe(
    Layer.provideMerge(Provenance.layer),
    Layer.provideMerge(hostOrders),
    Layer.provideMerge(infrastructure),
    Layer.provideMerge(receiverLayer),
    Layer.provide(policyLayer),
    Layer.provide(Layer.succeed(Service.ApprovalReviewTargets, [target])),
  );
  return { layer, calls, receiverLayer };
}
const setup = Effect.fn("ApprovalReviewHostOrderTest.setup")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (const threadId of [hostThreadId, vmThreadId])
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make(`project:${threadId}`),
      title: threadId,
      modelSelection: { instanceId: adapter.instanceId, model: "unused" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  const expiresAt = DateTime.toEpochMillis(yield* DateTime.now) + 60_000;
  const create = {
    clientRequestId: "human-send-one",
    sourceThreadId: hostThreadId,
    vmId: channel.vmId,
    text: originalText,
    expiresAt,
  };
  const orders = yield* HostOrders.ApprovalReviewHostOrders;
  const service = yield* Service.ApprovalReviewService;
  const projections = yield* Projections.ProjectionStoreV2;
  const order = yield* orders.create(create, human);
  const excerptStart = originalText.indexOf("Exakter Auftrag:");
  const proposal: ApprovalReviewSubmit = {
    orderId: order.source.orderId,
    submissionId: "proposal-one",
    expiresAt,
    excerpt: {
      startUtf16: excerptStart,
      endUtf16: originalText.length,
      text: originalText.slice(excerptStart),
    },
    action: {
      kind: "create_file_once",
      verifiedTargetId: target.verifiedTargetId,
      path: target.allowedPath,
      content: "reviewed file\n",
      mode: 384,
      expectedAbsent: true,
      implementationVersion: target.implementationVersion,
      implementationHash: hash(target.implementationSource),
    },
    agentRationale: "Agent rationale, separate from the host original.",
  };
  return { create, orders, service, projections, orchestrator, order, proposal };
});

it.effect(
  "persists the host original before forwarding and binds the actual VM message/run",
  () => {
    const fixture = scenario();
    return Effect.gen(function* () {
      const { order, service, proposal, projections } = yield* setup();
      assert.equal(order.state, "active");
      assert.equal(order.source.sourceEnvironmentId, hostEnvironmentId);
      assert.equal(order.source.threadId, hostThreadId);
      assert.equal(order.source.originalLink, `host-order:${order.source.orderId}`);
      assert.equal(order.assignment?.environmentId, vmEnvironmentId);
      assert.equal(order.assignment?.threadId, vmThreadId);
      assert.equal(order.assignment?.instructionHash, hash(forwardedOrderText(fixture.calls[0]!)));
      const vm = yield* projections.getThreadRecords(vmThreadId, ["runs", "messages"]);
      assert.equal(vm.runs[0]?.id, order.assignment?.runId);
      assert.equal(vm.messages[0]?.id, order.assignment?.messageId);
      assert.equal(vm.messages[0]?.text, forwardedOrderText(fixture.calls[0]!));
      assert.equal((yield* projections.getThreadRecords(hostThreadId, ["runs"])).runs.length, 0);
      const submitted = yield* service.submit(proposal, vmActor);
      assert.equal(submitted.threadId, hostThreadId);
      assert.equal(submitted.authority.originalOrder?.receipt.fullText, originalText);
      assert.deepEqual(submitted.authority.provenance, {
        status: "verified",
        reason: "trusted-original",
      });
      const review = yield* projections.getRuntimeResponseContext(
        hostThreadId,
        submitted.requestId,
      );
      assert.ok(review.item?.type === "approval_request");
      if (review.item?.type !== "approval_request") return;
      const detail = parseApprovalReviewDetail(review.item.prompt);
      assert.equal(detail.kind, "bundle");
      if (detail.kind !== "bundle") return;
      assert.deepEqual(yield* Effect.promise(() => verifyReviewBundle(detail.bundle)), {
        valid: true,
      });
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "one host order accepts multiple distinct packages, each with its own idempotence and hash",
  () => {
    const fixture = scenario();
    return Effect.gen(function* () {
      const { service, proposal } = yield* setup();
      const first = yield* service.submit(proposal, vmActor);
      const second = yield* service.submit(
        {
          ...proposal,
          submissionId: "proposal-two",
          action: { ...proposal.action, content: "second package\n" },
        },
        vmActor,
      );
      assert.notEqual(first.requestId, second.requestId);
      assert.notEqual(first.authority.packageHash, second.authority.packageHash);
      assert.equal((yield* service.submit(proposal, vmActor)).requestId, first.requestId);
      assert.equal(
        (yield* service
          .submit(
            { ...proposal, action: { ...proposal.action, content: "changed same id" } },
            vmActor,
          )
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      assert.equal(
        (yield* service
          .submit({ ...proposal, agentRationale: "changed same id" }, vmActor)
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      assert.lengthOf(fixture.calls, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "never turns a synthetic authenticated channel into human approval or a worker claim",
  () => {
    const fixture = scenario();
    return Effect.gen(function* () {
      const { service, proposal, orchestrator } = yield* setup();
      const submitted = yield* service.submit(proposal, vmActor);
      assert.equal(submitted.authority.originalOrder?.receipt.version, 2);
      const respond = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("synthetic-accept"),
        threadId: hostThreadId,
        requestId: submitted.requestId,
        packageHash: submitted.authority.packageHash,
        decision: "accept" as const,
      };
      const denied = yield* orchestrator.dispatch(respond).pipe(Effect.flip);
      assert.equal(denied._tag, "ApprovalReviewError");
      if (denied._tag === "ApprovalReviewError") assert.equal(denied.reason, "synthetic-order");
      assert.equal(
        (yield* service
          .claim(
            {
              threadId: hostThreadId,
              requestId: submitted.requestId,
              packageHash: submitted.authority.packageHash,
              verifiedTargetId: target.verifiedTargetId,
              claimId: "synthetic-claim",
            },
            target.workerSubject,
          )
          .pipe(Effect.flip)).reason,
        "synthetic-order",
      );
    }).pipe(
      Effect.provide(fixture.layer),
      Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
        sessionId: human.sessionId,
        subject: human.subject,
      }),
    );
  },
);

it.effect(
  "denies fake human, foreign/missing channel, copied order IDs and forged original fields",
  () => {
    const fixture = scenario();
    return Effect.gen(function* () {
      const { create, orders, service, proposal, order } = yield* setup();
      const otherCookie = { ...human, sessionId: AuthSessionId.make("agent-test-cookie") };
      assert.equal(
        (yield* orders
          .create({ ...create, clientRequestId: "fake-human" }, otherCookie)
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* orders
          .create({ ...create, clientRequestId: "vm-create" }, vmActor)
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* orders
          .create(
            { ...create, clientRequestId: "wrong-host-source", sourceThreadId: vmThreadId },
            human,
          )
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      for (const actor of [
        otherCookie,
        { ...vmActor, sessionId: AuthSessionId.make("other-vm") },
        { ...vmActor, proofKeyThumbprint: "x".repeat(43) },
        { ...vmActor, subject: "wrong-principal" },
        { ...vmActor, method: "bearer-access-token" as const },
        {
          ...vmActor,
          scopes: new Set<AuthEnvironmentScope>([
            "approval-review:request",
            "orchestration:operate",
          ]),
        },
      ]) {
        assert.equal(
          (yield* service.submit(proposal, actor).pipe(Effect.flip)).reason,
          "forbidden",
        );
      }
      assert.equal(
        (yield* service.submit({ ...proposal, orderId: "missing" }, vmActor).pipe(Effect.flip))
          .reason,
        "missing",
      );
      const foreign = yield* orders.create(
        { ...create, clientRequestId: "foreign-vm-order", vmId: "other-vm" },
        human,
      );
      assert.equal(
        (yield* service
          .submit({ ...proposal, orderId: foreign.source.orderId }, vmActor)
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      const raw = {
        ...proposal,
        originalOrder: { receipt: order.source },
        threadId: vmThreadId,
        vmId: "invented",
      };
      assert.isTrue(
        Exit.isFailure(
          yield* Schema.decodeUnknownEffect(ApprovalReviewSubmit)(raw, {
            onExcessProperty: "error",
          }).pipe(Effect.exit),
        ),
      );
      assert.equal(
        (yield* service.submit(raw, vmActor).pipe(Effect.flip)).reason,
        "invalid-action",
      );
      assert.equal(
        (yield* service
          .submit(
            { ...proposal, excerpt: { ...proposal.excerpt, text: "invented prompt" } },
            vmActor,
          )
          .pipe(Effect.flip)).reason,
        "unverified-original",
      );
      assert.equal(
        (yield* service
          .submit(
            {
              ...proposal,
              excerpt: {
                ...proposal.excerpt,
                text: proposal.excerpt.text.replaceAll("\r\n", "\n"),
              },
            },
            vmActor,
          )
          .pipe(Effect.flip)).reason,
        "unverified-original",
      );
      const emoji = originalText.indexOf("😀");
      assert.equal(
        (yield* service
          .submit(
            { ...proposal, excerpt: { startUtf16: emoji, endUtf16: emoji + 1, text: "\ud83d" } },
            vmActor,
          )
          .pipe(Effect.flip)).reason,
        "unverified-original",
      );
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "same create ID recovers a lost ACK without forwarding again, and altered input conflicts",
  () => {
    const fixture = scenario({ loseAck: true });
    return Effect.gen(function* () {
      const { create, orders, order, service, proposal } = yield* setup();
      assert.equal(order.state, "forward-unknown");
      assert.isNull(order.assignment);
      assert.equal((yield* orders.create(create, human)).source.orderId, order.source.orderId);
      yield* TestClock.adjust(60_001);
      assert.equal((yield* orders.create(create, human)).source.orderId, order.source.orderId);
      assert.lengthOf(fixture.calls, 1);
      assert.equal(
        (yield* orders.create({ ...create, text: "changed" }, human).pipe(Effect.flip)).reason,
        "conflict",
      );
      assert.equal((yield* service.submit(proposal, vmActor).pipe(Effect.flip)).reason, "expired");
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "cancellation and expiry block further proposals; package/source tampering never verifies",
  () => {
    const fixture = scenario();
    return Effect.gen(function* () {
      const { create, orders, service, proposal } = yield* setup();
      const submitted = yield* service.submit(proposal, vmActor);
      const originalOrder = submitted.authority.originalOrder!;
      if (originalOrder.receipt.version !== 2) return assert.fail();
      const mutated: ApprovalReviewOriginalOrder = {
        ...originalOrder,
        receipt: { ...originalOrder.receipt, principal: "invented-human" },
      };
      assert.deepEqual(
        yield* Provenance.verifyAuthority({
          ...submitted,
          authority: { ...submitted.authority, originalOrder: mutated },
        }),
        { status: "unverified", reason: "package-mismatch" },
      );
      const verifier = yield* Provenance.ApprovalReviewProvenance;
      assert.deepEqual(
        yield* verifier.verify(
          mutated,
          hostThreadId,
          submitted.requestId,
          submitted.authority.packageHash,
        ),
        { status: "unverified", reason: "invalid-original" },
      );
      yield* orders.cancel(proposal.orderId, human);
      assert.equal(
        (yield* service
          .submit({ ...proposal, submissionId: "after-cancel" }, vmActor)
          .pipe(Effect.flip)).reason,
        "order-inactive",
      );
      assert.deepEqual((yield* service.read(submitted, vmActor)).provenance, {
        status: "unverified",
        reason: "order-inactive",
      });
      const second = yield* orders.create(
        { ...create, clientRequestId: "second-human-send" },
        human,
      );
      yield* TestClock.adjust(60_001);
      assert.equal(
        (yield* service
          .submit({ ...proposal, orderId: second.source.orderId }, vmActor)
          .pipe(Effect.flip)).reason,
        "expired",
      );
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "configured human policy preserves separate hash approvals, racing one-claim CAS and unknown receipt",
  () => {
    const fixture = scenario({ synthetic: false });
    return Effect.gen(function* () {
      const { service, proposal, orchestrator } = yield* setup();
      const first = yield* service.submit(proposal, vmActor);
      const second = yield* service.submit(
        {
          ...proposal,
          submissionId: "another-proposal",
          action: { ...proposal.action, content: "another\n" },
        },
        vmActor,
      );
      for (const submitted of [first, second])
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`approve:${submitted.requestId}`),
          threadId: hostThreadId,
          requestId: submitted.requestId,
          packageHash: submitted.authority.packageHash,
          decision: "accept",
        });
      const claim = {
        threadId: hostThreadId,
        requestId: first.requestId,
        packageHash: first.authority.packageHash,
        verifiedTargetId: target.verifiedTargetId,
        claimId: "one",
      };
      const outcomes = yield* Effect.all(
        [
          service.claim(claim, target.workerSubject).pipe(Effect.exit),
          service.claim({ ...claim, claimId: "two" }, target.workerSubject).pipe(Effect.exit),
        ],
        { concurrency: 2 },
      );
      assert.equal(outcomes.filter(Exit.isSuccess).length, 1);
      const claimed = yield* service.read(first, target.workerSubject, true);
      const receipt = {
        ...claim,
        claimId: claimed.claimId!,
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
        (yield* service.claim(claim, target.workerSubject).pipe(Effect.flip)).reason,
        "replayed",
      );
      assert.equal((yield* service.read(second, vmActor)).state, "approved");
    }).pipe(
      Effect.provide(fixture.layer),
      Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
        sessionId: human.sessionId,
        subject: human.subject,
      }),
    );
  },
);

for (const operation of ["accept", "claim"] as const)
  it.effect(
    `cancel waits for an in-flight ${operation} commit and reports irreversible claims`,
    () => {
      const fixture = scenario({ synthetic: false });
      return Effect.scoped(
        Effect.gen(function* () {
          const { orders, service, proposal, orchestrator } = yield* setup();
          const first = yield* service.submit(proposal, vmActor);
          const second = yield* service.submit(
            {
              ...proposal,
              submissionId: "separate-before-cancel",
              action: { ...proposal.action, content: "another package\n" },
            },
            vmActor,
          );
          for (const submitted of operation === "claim" ? [first, second] : [second])
            yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make(`preapprove:${submitted.requestId}`),
              threadId: hostThreadId,
              requestId: submitted.requestId,
              packageHash: submitted.authority.packageHash,
              decision: "accept",
            });
          const beforeCommit = yield* Deferred.make<void>();
          const releaseCommit = yield* Deferred.make<void>();
          const cancelQueued = yield* Deferred.make<void>();
          const eventSink = yield* EventSink.EventSinkV2;
          const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
          const commit = eventSink.commitCommand;
          const withLock = executor.withLock;
          const acceptId = CommandId.make("racing-accept");
          const commitSpy = vi
            .spyOn(eventSink, "commitCommand")
            .mockImplementation((input) =>
              (
                operation === "claim"
                  ? input.commandType === "approval-review.claim"
                  : input.commandId === acceptId
              )
                ? Deferred.succeed(beforeCommit, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCommit)),
                    Effect.andThen(commit(input)),
                  )
                : commit(input),
            );
          let lockRequests = 0;
          const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
            key,
            effect,
          ) =>
            key === hostThreadId && ++lockRequests === 2
              ? Deferred.succeed(cancelQueued, undefined).pipe(
                  Effect.andThen(withLock(key, effect)),
                )
              : withLock(key, effect);
          const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
          yield* Effect.gen(function* () {
            const firstOperation =
              operation === "claim"
                ? service
                    .claim(
                      {
                        threadId: hostThreadId,
                        requestId: first.requestId,
                        packageHash: first.authority.packageHash,
                        verifiedTargetId: target.verifiedTargetId,
                        claimId: "committed-before-cancel",
                      },
                      target.workerSubject,
                    )
                    .pipe(Effect.asVoid)
                : orchestrator
                    .dispatch({
                      type: "runtime-request.respond",
                      commandId: acceptId,
                      threadId: hostThreadId,
                      requestId: first.requestId,
                      packageHash: first.authority.packageHash,
                      decision: "accept",
                    })
                    .pipe(Effect.asVoid);
            const operationFiber = yield* firstOperation.pipe(Effect.forkScoped);
            yield* Effect.raceFirst(
              Deferred.await(beforeCommit),
              Fiber.join(operationFiber).pipe(
                Effect.andThen(Effect.die("Operation bypassed the commit barrier")),
              ),
            );
            const cancelFiber = yield* orders
              .cancel(proposal.orderId, human)
              .pipe(Effect.forkScoped);
            yield* Effect.raceFirst(
              Deferred.await(cancelQueued),
              Fiber.join(cancelFiber).pipe(
                Effect.andThen(Effect.die("Cancel bypassed the in-flight thread lock")),
              ),
            );
            assert.equal((yield* orders.read(proposal.orderId, human)).state, "active");
            assert.equal(
              (yield* service.read(first, target.workerSubject, true)).state,
              operation === "claim" ? "approved" : "pending",
            );
            yield* Deferred.succeed(releaseCommit, undefined);
            yield* Fiber.join(operationFiber);
            const cancelled = yield* Fiber.join(cancelFiber);
            assert.equal(cancelled.state, "cancelled");
            assert.deepEqual(
              cancelled.alreadyClaimedActions,
              operation === "claim"
                ? [
                    {
                      threadId: hostThreadId,
                      requestId: first.requestId,
                      packageHash: first.authority.packageHash,
                      claimId: "committed-before-cancel",
                      state: "claimed",
                      action: first.authority.action,
                    },
                  ]
                : [],
            );
            for (const submitted of [first, second])
              assert.equal(
                (yield* service
                  .claim(
                    {
                      threadId: hostThreadId,
                      requestId: submitted.requestId,
                      packageHash: submitted.authority.packageHash,
                      verifiedTargetId: target.verifiedTargetId,
                      claimId: "after-cancel",
                    },
                    target.workerSubject,
                  )
                  .pipe(Effect.flip)).reason,
                "unverified-original",
              );
            assert.equal(
              (yield* service
                .submit({ ...proposal, submissionId: "after-cancel" }, vmActor)
                .pipe(Effect.flip)).reason,
              "order-inactive",
            );
            if (operation === "claim") {
              yield* service.receipt(
                {
                  threadId: hostThreadId,
                  requestId: first.requestId,
                  packageHash: first.authority.packageHash,
                  verifiedTargetId: target.verifiedTargetId,
                  claimId: "committed-before-cancel",
                  receipt: { outcome: "unknown" },
                },
                target.workerSubject,
              );
              const repeated = yield* orders.cancel(proposal.orderId, human);
              assert.equal(repeated.alreadyClaimedActions[0]?.state, "completed");
              assert.equal(repeated.alreadyClaimedActions[0]?.claimId, "committed-before-cancel");
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                commitSpy.mockRestore();
                lockSpy.mockRestore();
              }),
            ),
          );
        }),
      ).pipe(
        Effect.provide(fixture.layer),
        Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
          sessionId: human.sessionId,
          subject: human.subject,
        }),
      );
    },
  );

it.effect("cancel winning the thread lock denies both a waiting accept and a waiting claim", () => {
  const fixture = scenario({ synthetic: false });
  return Effect.scoped(
    Effect.gen(function* () {
      const { orders, service, proposal, orchestrator } = yield* setup();
      const approved = yield* service.submit(proposal, vmActor);
      const pending = yield* service.submit(
        { ...proposal, submissionId: "pending-before-cancel" },
        vmActor,
      );
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("approve-before-cancel"),
        threadId: hostThreadId,
        requestId: approved.requestId,
        packageHash: approved.authority.packageHash,
        decision: "accept",
      });
      const cancelHolding = yield* Deferred.make<void>();
      const releaseCancel = yield* Deferred.make<void>();
      const acceptQueued = yield* Deferred.make<void>();
      const claimQueued = yield* Deferred.make<void>();
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const withLock = executor.withLock;
      let lockRequests = 0;
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== hostThreadId) return withLock(key, effect);
        switch (++lockRequests) {
          case 1:
            return withLock(
              key,
              Deferred.succeed(cancelHolding, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCancel)),
                Effect.andThen(effect),
              ),
            );
          case 2:
            return Deferred.succeed(acceptQueued, undefined).pipe(
              Effect.andThen(withLock(key, effect)),
            );
          case 3:
            return Deferred.succeed(claimQueued, undefined).pipe(
              Effect.andThen(withLock(key, effect)),
            );
          default:
            return withLock(key, effect);
        }
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const cancelFiber = yield* orders.cancel(proposal.orderId, human).pipe(Effect.forkScoped);
        yield* Effect.raceFirst(
          Deferred.await(cancelHolding),
          Fiber.join(cancelFiber).pipe(
            Effect.andThen(Effect.die("Cancel did not acquire the canonical thread lock")),
          ),
        );
        const acceptFiber = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("accept-after-cancel-lock"),
            threadId: hostThreadId,
            requestId: pending.requestId,
            packageHash: pending.authority.packageHash,
            decision: "accept",
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.raceFirst(
          Deferred.await(acceptQueued),
          Fiber.join(acceptFiber).pipe(
            Effect.andThen(Effect.die("Accept bypassed cancellation's lock")),
          ),
        );
        const claimFiber = yield* service
          .claim(
            {
              threadId: hostThreadId,
              requestId: approved.requestId,
              packageHash: approved.authority.packageHash,
              verifiedTargetId: target.verifiedTargetId,
              claimId: "cancel-wins",
            },
            target.workerSubject,
          )
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.raceFirst(
          Deferred.await(claimQueued),
          Fiber.join(claimFiber).pipe(
            Effect.andThen(Effect.die("Claim bypassed cancellation's lock")),
          ),
        );
        yield* Deferred.succeed(releaseCancel, undefined);
        const cancelled = yield* Fiber.join(cancelFiber);
        assert.equal(cancelled.state, "cancelled");
        assert.deepEqual(cancelled.alreadyClaimedActions, []);
        const acceptError = yield* Fiber.join(acceptFiber);
        assert.equal(acceptError._tag, "ApprovalReviewError");
        if (acceptError._tag === "ApprovalReviewError")
          assert.equal(acceptError.reason, "unverified-original");
        assert.equal((yield* Fiber.join(claimFiber)).reason, "unverified-original");
        assert.equal((yield* service.read(approved, target.workerSubject, true)).state, "approved");
        assert.equal((yield* service.read(pending, target.workerSubject, true)).state, "pending");
      }).pipe(Effect.ensuring(Effect.sync(() => lockSpy.mockRestore())));
    }),
  ).pipe(
    Effect.provide(fixture.layer),
    Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
      sessionId: human.sessionId,
      subject: human.subject,
    }),
  );
});

it.effect("marks an interrupted forward unknown and never forwards the same human send again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fixture = scenario({
        beforeAck: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      return yield* Effect.gen(function* () {
        const expiresAt = DateTime.toEpochMillis(yield* DateTime.now) + 60_000;
        const fiber = yield* setup().pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const orders = yield* HostOrders.ApprovalReviewHostOrders;
        const recovered = yield* orders.create(
          {
            clientRequestId: "human-send-one",
            sourceThreadId: hostThreadId,
            vmId: channel.vmId,
            text: originalText,
            expiresAt,
          },
          human,
        );
        assert.equal(recovered.state, "forward-unknown");
        assert.lengthOf(fixture.calls, 1);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect(
  "receiver pins host session/thread and returns the same canonical ACK without a second run",
  () => {
    const fixture = scenario();
    return Effect.gen(function* () {
      const { order, projections } = yield* setup();
      const receiver = yield* Receiver.ApprovalReviewOrderReceiver;
      const delivery = fixture.calls[0]!;
      const duplicate = yield* receiver.receive(delivery, hostSender);
      assert.deepEqual(duplicate, order.assignment);
      assert.lengthOf((yield* projections.getThreadRecords(vmThreadId, ["runs"])).runs, 1);
      assert.equal(
        (yield* receiver
          .receive({ ...delivery, text: "changed", fullTextHash: hash("changed") }, hostSender)
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      assert.equal(
        (yield* receiver
          .receive({ ...delivery, targetThreadId: hostThreadId }, hostSender)
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* receiver
          .receive(delivery, { ...hostSender, proofKeyThumbprint: "x".repeat(43) })
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* receiver.receive(delivery, vmActor).pipe(Effect.flip)).reason,
        "forbidden",
      );
      const sql = yield* SqlClient.SqlClient;
      assert.isTrue(
        Exit.isFailure(
          yield* sql`UPDATE approval_review_host_orders SET source_json = '{}' WHERE order_id = ${order.source.orderId}`.pipe(
            Effect.exit,
          ),
        ),
      );
    }).pipe(Effect.provide(fixture.layer));
  },
);
