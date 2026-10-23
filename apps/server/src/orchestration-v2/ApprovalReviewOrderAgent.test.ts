import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { assert, it } from "@effect/vitest";
import {
  ApprovalReviewError,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RuntimeRequestId,
  ThreadId,
  type ApprovalReviewAgentPropose,
  type ApprovalReviewForwardAck,
  type ApprovalReviewHostOrder,
  type ApprovalReviewSubmit,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Agent from "./ApprovalReviewOrderAgent.ts";
import * as Forward from "./ApprovalReviewOrderForward.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";
import * as Receiver from "./ApprovalReviewOrderReceiver.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Projections from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as Replay from "./testkit/ProviderReplayHarness.ts";
import { canonical, hash } from "./ApprovalReviewPackage.ts";

const threadId = ThreadId.make("agent-vm-thread");
const hostThreadId = ThreadId.make("agent-host-control");
const environmentId = EnvironmentId.make("agent-vm-environment");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "inert-test-provider" };
const host: Policy.ForwardDestination = {
  environmentId: EnvironmentId.make("agent-host-environment"),
  forward: {
    credentialSecretName: "test-callback-token",
    proofKeySecretName: "test-callback-key",
    sessionId: AuthSessionId.make("vm-to-host-session"),
    subject: "vm-requester",
  },
};
const sender: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("agent-host-sender"),
  subject: "host-forward",
  method: "dpop-access-token",
  proofKeyThumbprint: "h".repeat(43),
  scopes: new Set(["orchestration:operate"]),
};
const original = "Synthetic original\r\nExact 😀 excerpt";

const fixture = Effect.fn("ApprovalReviewOrderAgentTest.fixture")(function* () {
  const cwd = yield* checkpointWorkspace("approval-order-agent");
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const reads: string[] = [];
  const proposals: ApprovalReviewSubmit[] = [];
  let callbackOrder: ApprovalReviewHostOrder | undefined;
  let callbackLost = false;
  // The real worker opens this inert adapter; no CLI, model request or runtime auth is involved.
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: ({ existingProviderThread }) =>
            existingProviderThread === undefined
              ? Effect.die("The canonical provider thread must already exist")
              : Effect.succeed({
                  ...existingProviderThread,
                  providerSessionId: input.providerSessionId,
                  nativeThreadRef: { driver, nativeId: "inert-native-thread", strength: "strong" },
                }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.sync(() => {
              started.push(turn);
            }),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  const forward = Forward.ApprovalReviewOrderForward.of({
    ready: () => Effect.die("Agent tools cannot create or forward orders"),
    send: () => Effect.die("Agent tools cannot create or forward orders"),
    readOrder: (destination, testOnly, orderId) =>
      Effect.suspend(() => {
        assert.deepEqual(destination, host);
        assert.isTrue(testOnly);
        reads.push(orderId);
        if (callbackLost)
          return Effect.fail(new ApprovalReviewError({ reason: "forward-unknown" }));
        return callbackOrder === undefined
          ? Effect.die("Receiver ACK must be installed before callback")
          : Effect.succeed(callbackOrder);
      }),
    propose: (destination, testOnly, input) =>
      Effect.suspend(() => {
        assert.deepEqual(destination, host);
        assert.isTrue(testOnly);
        proposals.push(input);
        if (callbackLost)
          return Effect.fail(new ApprovalReviewError({ reason: "forward-unknown" }));
        return Effect.succeed({
          threadId: hostThreadId,
          requestId: RuntimeRequestId.make(`proposal:${input.submissionId}`),
          authority: {
            packageHash: hash(canonical(input)),
            verifiedTargetId: input.action.verifiedTargetId,
            expiresAt: input.expiresAt,
            state: "pending" as const,
            approverSessionId: AuthSessionId.make("synthetic-ui"),
            approverSubject: "synthetic-owner",
            requesterSubject: host.forward.subject,
            workerSubject: "unprovisioned-worker",
            action: input.action,
            implementationSource: "inert fixture",
          },
        });
      }),
  });
  const database = Sqlite.layerMemory;
  const runtime = Layer.mergeAll(
    database,
    Projections.layer.pipe(Layer.provide(database)),
    Replay.layerWithRegistry(
      { name: "approval-order-agent" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
  const policy = Layer.succeed(Policy.ApprovalReviewOrderPolicy, {
    humans: [],
    channels: [],
    receiver: {
      sessionId: sender.sessionId,
      subject: sender.subject,
      proofKeyThumbprint: sender.proofKeyThumbprint!,
      threadId,
      testOnly: true,
      host,
    },
  });
  const layer = Layer.mergeAll(Agent.layer, Receiver.layer).pipe(
    Layer.provideMerge(runtime),
    Layer.provide(policy),
    Layer.provide(Layer.succeed(Forward.ApprovalReviewOrderForward, forward)),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
  );
  return {
    cwd,
    layer,
    started,
    reads,
    proposals,
    loseCallback: () => {
      callbackLost = true;
    },
    installOrder: (ack: ApprovalReviewForwardAck, expiresAt: number) => {
      callbackOrder = {
        source: {
          version: 2,
          orderId: ack.orderId,
          orderRevision: 1,
          sourceKind: "synthetic",
          testOnly: true,
          sourceEnvironmentId: host.environmentId,
          sessionId: AuthSessionId.make("synthetic-ui"),
          principal: "synthetic-owner",
          threadId: hostThreadId,
          messageId: MessageId.make(`host-order:${ack.orderId}`),
          createdAt: expiresAt - 60_000,
          expiresAt,
          fullText: original,
          fullTextHash: hash(original),
          originalLink: `host-order:${ack.orderId}`,
        },
        vmId: "synthetic-vm",
        targetThreadId: threadId,
        state: "active",
        assignment: ack,
        forwardRevision: 1,
      };
    },
  };
});

const receive = Effect.fn("ApprovalReviewOrderAgentTest.receive")(function* (cwd: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-agent-vm"),
    threadId,
    projectId: ProjectId.make("agent-vm-project"),
    title: "Synthetic agent order",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
    createdBy: "agent",
    creationSource: "server",
  });
  const expiresAt = DateTime.toEpochMillis(yield* DateTime.now) + 60_000;
  const receiver = yield* Receiver.ApprovalReviewOrderReceiver;
  const ack = yield* receiver.receive(
    {
      testOnly: true,
      orderId: "order:agent-test",
      orderRevision: 1,
      text: original,
      fullTextHash: hash(original),
      expiresAt,
      targetThreadId: threadId,
      commandId: "host-order:order:agent-test:forward:1",
      messageId: MessageId.make("host-order:order:agent-test:vm-message"),
    },
    sender,
  );
  const proposal: ApprovalReviewAgentPropose = {
    submissionId: "one",
    expiresAt,
    excerpt: { startUtf16: 0, endUtf16: original.length, text: original },
    agentRationale: "Separate agent reasoning",
    action: {
      kind: "create_file_once",
      verifiedTargetId: "inert-target",
      path: "/tmp/never-executed",
      content: "inert",
      mode: 384,
      expectedAbsent: true,
      implementationVersion: "test",
      implementationHash: hash("inert fixture"),
    },
  };
  return { ack, expiresAt, proposal, orchestrator, agent: yield* Agent.ApprovalReviewOrderAgent };
});
const start = Effect.fn("ApprovalReviewOrderAgentTest.start")(function* (
  commandId = "release-agent-order",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const prepared = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
    (candidate) => candidate.status === "preparing",
  );
  if (prepared === undefined)
    return yield* Effect.die("Receiver delivery must persist its prepared run before release");
  yield* orchestrator.dispatch({
    type: "prepared-run.release",
    commandId: CommandId.make(commandId),
    threadId,
    runId: prepared.id,
  });
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  const snapshot = yield* orchestrator.getThreadProjection(threadId);
  const run = snapshot.runs.find((candidate) => candidate.status === "running");
  const providerThread = snapshot.providerThreads.find(
    (candidate) => candidate.id === run?.providerThreadId,
  );
  if (run === undefined || providerThread?.providerSessionId == null)
    return yield* Effect.die("Canonical worker did not start the assigned run");
  assert.equal(run.id, prepared.id);
  assert.equal(snapshot.thread.activeProviderThreadId, providerThread.id);
  assert.isTrue(
    snapshot.attempts.some(
      (attempt) => attempt.id === run.activeAttemptId && attempt.runId === run.id,
    ),
  );
  const scope: McpInvocationScope = {
    environmentId,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "agent-test",
    client: undefined,
    thread: {
      threadId,
      providerInstanceId: instanceId,
      providerSessionId: providerThread.providerSessionId,
    },
  };
  return { scope, run, snapshot };
});

it.effect(
  "binds current and propose to the actual running receiver ACK, never caller order IDs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const { ack, expiresAt, proposal, agent } = yield* receive(f.cwd);
          f.installOrder(ack, expiresAt);
          const { scope, run } = yield* start();
          assert.equal(run.id, ack.runId);
          assert.equal(f.started[0]?.runId, ack.runId);
          const order = yield* agent.current(scope);
          assert.equal(order.source.orderId, ack.orderId);
          const result = yield* agent.propose(scope, {
            ...proposal,
            orderId: "invented-order",
          } as ApprovalReviewAgentPropose);
          assert.equal(result.threadId, hostThreadId);
          assert.deepEqual(f.reads, [ack.orderId]);
          assert.deepEqual(f.proposals, [{ ...proposal, orderId: ack.orderId }]);
        }).pipe(Effect.provide(f.layer));
      }),
    ),
);

it.effect(
  "denies defer_start, missing capability/context and foreign provider session/thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const { ack, proposal, agent, orchestrator } = yield* receive(f.cwd);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "preparing",
          );
          const preparingScope: McpInvocationScope = {
            environmentId,
            capabilities: new Set(["orchestration"]),
            issuedAt: 0,
            requestNamespace: "preparing",
            client: undefined,
            thread: {
              threadId,
              providerInstanceId: instanceId,
              providerSessionId: "unstarted-session",
            },
          };
          assert.equal(
            (yield* agent.current(preparingScope).pipe(Effect.flip)).reason,
            "forbidden",
          );
          assert.equal(
            (yield* agent.propose(preparingScope, proposal).pipe(Effect.flip)).reason,
            "forbidden",
          );
          assert.lengthOf(f.started, 0);
          const { scope, run } = yield* start();
          assert.equal(run.id, ack.runId);
          for (const foreign of [
            { ...scope, thread: undefined },
            { ...scope, capabilities: new Set<never>() },
            { ...scope, thread: { ...scope.thread!, providerSessionId: "foreign-session" } },
            { ...scope, thread: { ...scope.thread!, threadId: ThreadId.make("foreign-thread") } },
            {
              ...scope,
              thread: {
                ...scope.thread!,
                providerInstanceId: ProviderInstanceId.make("foreign-provider"),
              },
            },
          ]) {
            assert.equal((yield* agent.current(foreign).pipe(Effect.flip)).reason, "forbidden");
            assert.equal(
              (yield* agent.propose(foreign, proposal).pipe(Effect.flip)).reason,
              "forbidden",
            );
          }
          assert.lengthOf(f.reads, 0);
          assert.lengthOf(f.proposals, 0);
        }).pipe(Effect.provide(f.layer));
      }),
    ),
);

it.effect("denies a missing active attempt or an ACK from another run/host session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const { ack, proposal, agent } = yield* receive(f.cwd);
        const { scope, run, snapshot } = yield* start();
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("agent-foreign-active-provider-thread"),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: {
                ...snapshot.thread,
                activeProviderThreadId: ProviderThreadId.make("foreign-active-provider-thread"),
              },
            },
          ],
        });
        assert.equal((yield* agent.current(scope).pipe(Effect.flip)).reason, "forbidden");
        assert.equal((yield* agent.propose(scope, proposal).pipe(Effect.flip)).reason, "forbidden");
        yield* sink.write({
          events: [
            {
              id: EventId.make("agent-restore-active-provider-thread"),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: snapshot.thread,
            },
          ],
        });
        yield* sink.write({
          events: [
            {
              id: EventId.make("agent-missing-attempt"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, activeAttemptId: RunAttemptId.make("not-this-run-attempt") },
            },
          ],
        });
        assert.equal((yield* agent.current(scope).pipe(Effect.flip)).reason, "forbidden");
        assert.equal((yield* agent.propose(scope, proposal).pipe(Effect.flip)).reason, "forbidden");
        yield* sink.write({
          events: [
            {
              id: EventId.make("agent-restore-attempt"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: run,
            },
          ],
        });
        const sql = yield* SqlClient.SqlClient;
        const otherAck = { ...ack, runId: "run:another-assignment" };
        yield* sql`UPDATE approval_review_order_deliveries SET ack_json = ${canonical(otherAck)} WHERE order_id = ${ack.orderId}`;
        assert.equal((yield* agent.current(scope).pipe(Effect.flip)).reason, "forbidden");
        assert.equal((yield* agent.propose(scope, proposal).pipe(Effect.flip)).reason, "forbidden");
        yield* sql`UPDATE approval_review_order_deliveries SET ack_json = ${canonical(ack)}, state = 'receiving' WHERE order_id = ${ack.orderId}`;
        assert.equal((yield* agent.current(scope).pipe(Effect.flip)).reason, "forbidden");
        assert.equal((yield* agent.propose(scope, proposal).pipe(Effect.flip)).reason, "forbidden");
        yield* sql`UPDATE approval_review_order_deliveries SET state = 'received', host_session_id = 'foreign-host-session' WHERE order_id = ${ack.orderId}`;
        assert.equal((yield* agent.current(scope).pipe(Effect.flip)).reason, "forbidden");
        assert.equal((yield* agent.propose(scope, proposal).pipe(Effect.flip)).reason, "forbidden");
        assert.lengthOf(f.reads, 0);
        assert.lengthOf(f.proposals, 0);
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);

it.effect("does not reuse the earlier order ACK for a subsequent canonical run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const { ack, proposal, agent, orchestrator } = yield* receive(f.cwd);
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("cancel-earlier-agent-order"),
          threadId,
          runId: ack.runId,
        });
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
          "interrupted",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("later-agent-message"),
          threadId,
          messageId: MessageId.make("later-agent-message"),
          text: "Unassigned subsequent message",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        const { scope, run: later } = yield* start("release-later-agent-run");
        assert.notEqual(later.id, ack.runId);
        assert.equal(later.ordinal, ack.runOrdinal + 1);
        assert.equal(f.started.at(-1)?.runId, later.id);
        assert.equal((yield* agent.current(scope).pipe(Effect.flip)).reason, "forbidden");
        assert.equal((yield* agent.propose(scope, proposal).pipe(Effect.flip)).reason, "forbidden");
        assert.lengthOf(f.reads, 0);
        assert.lengthOf(f.proposals, 0);
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);

it.effect("returns lost callback responses without automatically retrying current or propose", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const { ack, proposal, agent } = yield* receive(f.cwd);
        const { scope } = yield* start();
        f.loseCallback();
        assert.equal((yield* agent.current(scope).pipe(Effect.flip)).reason, "forward-unknown");
        assert.deepEqual(f.reads, [ack.orderId]);
        assert.equal(
          (yield* agent.propose(scope, proposal).pipe(Effect.flip)).reason,
          "forward-unknown",
        );
        assert.deepEqual(f.proposals, [{ ...proposal, orderId: ack.orderId }]);
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);
