import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off -- The protocol fixture owns only its temporary IPC endpoint and exercises no desktop or provider process.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  IsoDateTime,
  NativeAuthorRequest,
  NativeAuthorResponse,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { startDesktopAppControlServer } from "../../../desktop/src/app/DesktopAppControlServer.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as NativeAuthor from "./NativeAuthorService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture-model" };
const projectId = ProjectId.make("fixture-scratch");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider calls are permitted in this fixture"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, CommandReceiptStore.layer).pipe(
  Layer.provide(database),
);
const threadLayer = ThreadManagement.layer.pipe(
  Layer.provideMerge(
    ProviderReplayHarness.layerWithRegistry(
      { name: "native-author" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  ),
  Layer.provideMerge(stores),
  Layer.provideMerge(ServerSettings.layerTest({ defaultModelSelection: modelSelection })),
  Layer.provideMerge(NodeServices.layer),
);
const dependencies = Layer.mergeAll(
  threadLayer,
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/tmp/native-author-fixture-projects",
    ensureScratchProject: Effect.succeed({ projectId }),
    folderForThread: () => Effect.succeedSome("/tmp/native-author-fixture-scratch"),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () =>
      Effect.succeedSome({
        id: projectId,
        title: "Scratch",
        workspaceRoot: "/tmp/native-author-fixture-scratch",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: IsoDateTime.make("2026-10-17T00:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-10-17T00:00:00.000Z"),
        deletedAt: null,
      }),
  }),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-primary")),
  }),
);

const submit = {
  version: 1,
  type: "native-author",
  requestId: "submit-1",
  source: { engineSessionId: "pi-1", conversationId: "conversation-1", turnId: "turn-1" },
  operation: "submit",
  text: "Explain this task.",
} as const;
const decodeResponse = Schema.decodeUnknownSync(NativeAuthorResponse);
const isRequest = Schema.is(NativeAuthorRequest);
const exchange = (address: string, request: unknown) =>
  new Promise<NativeAuthorResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      socket.destroy();
      assert.isAtMost(Buffer.byteLength(buffer), 65_536);
      try {
        resolve(decodeResponse(JSON.parse(buffer)));
      } catch (error) {
        reject(error);
      }
    });
  });

it.effect(
  "persists one canonical source/run across reconnects, streams bounded scalar-safe snapshots and exposes waiting approval without native approval authority",
  () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const program = Effect.gen(function* () {
        const service = yield* NativeAuthor.NativeAuthorService;
        const missing = yield* service.execute({ ...submit, operation: "read" }).pipe(Effect.flip);
        assert.equal(missing.code, "not-submitted");
        const first = yield* service.execute(submit);
        assert.equal(first.status, "queued");
        assert.equal(first.locator.source.turnId, submit.source.turnId);
        const projection = yield* orchestrator.getThreadProjection(first.locator.threadId);
        assert.equal(projection.thread.creationSource, "server");
        assert.equal(projection.thread.runtimeMode, "approval-required");
        assert.isNull(projection.thread.lineage.parentThreadId);
        assert.lengthOf(projection.runs, 1);
        assert.deepEqual((yield* service.execute(submit)).locator, first.locator);
        assert.equal(
          (yield* service.execute({ ...submit, text: "Changed" }).pipe(Effect.flip)).code,
          "receipt-conflict",
        );
        assert.equal(
          (yield* service.execute({ ...submit, requestId: "changed" }).pipe(Effect.flip)).code,
          "receipt-conflict",
        );
        assert.equal(
          (yield* service
            .execute({ ...submit, operation: "cancel", expectedRunId: RunId.make("other-run") })
            .pipe(Effect.flip)).code,
          "stale-run",
        );
        const second = yield* service.execute({
          ...submit,
          requestId: "submit-2",
          source: { ...submit.source, turnId: "turn-2" },
        });
        assert.equal(second.locator.threadId, first.locator.threadId);
        assert.notEqual(second.locator.runId, first.locator.runId);
        const other = yield* service.execute({
          ...submit,
          source: { ...submit.source, conversationId: "conversation-2" },
        });
        assert.notEqual(other.locator.threadId, first.locator.threadId);
        const limited = yield* service
          .execute({
            ...submit,
            source: { ...submit.source, conversationId: "limited-conversation" },
          })
          .pipe(
            Effect.provideService(DispatchModeLimit, {
              runtimeMode: "approval-required",
              interactionMode: "plan",
            }),
          );
        assert.equal(
          (yield* threads.getThreadRecords(limited.locator.threadId, [])).thread.interactionMode,
          "plan",
        );
        const now = yield* DateTime.now;
        const run = projection.runs[0]!;
        const item = {
          id: TurnItemId.make("assistant-fixture"),
          threadId: first.locator.threadId,
          runId: run.id,
          nodeId: run.rootNodeId ?? NodeId.make("fixture-root"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "running" as const,
          title: "Assistant",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const text = `${"x".repeat(8_191)}😀${'\u0001"\\'.repeat(6_000)}`;
        let ordinal = 0;
        const write = (event: OrchestrationV2DomainEvent) => sink.write({ events: [event] });
        const base = () => ({
          id: EventId.make(`native-output:${ordinal++}`),
          threadId: item.threadId,
          providerInstanceId: instanceId,
          occurredAt: now,
        });
        yield* write({
          ...base(),
          type: "turn-item.updated",
          payload: {
            ...item,
            type: "assistant_message",
            messageId: run.userMessageId,
            text,
            streaming: true,
          },
        });
        yield* write({
          ...base(),
          type: "turn-item.updated",
          payload: {
            ...item,
            id: TurnItemId.make("approval-fixture"),
            ordinal: 3,
            type: "approval_request",
            requestId: RuntimeRequestId.make("approval-1"),
            requestKind: "command",
            prompt: "PRIVATE approval command",
            status: "waiting",
          },
        });
        yield* write({ ...base(), type: "run.updated", payload: { ...run, status: "waiting" } });
        const waiting = yield* service.execute({ ...submit, operation: "open-results" });
        assert.equal(waiting.status, "waiting");
        assert.equal(waiting.locator.runId, run.id);
        let cursor = first.cursor;
        let assembled = "";
        const phases: string[] = [];
        for (let page = 0; page < 20; page++) {
          const state = yield* service.execute({ ...submit, operation: "read", after: cursor });
          assert.equal(state.gap, null);
          assert.isAtMost(
            Buffer.byteLength(
              JSON.stringify({ version: 1, requestId: submit.requestId, ok: true, state }) + "\n",
            ),
            65_536,
          );
          for (const out of state.output) {
            assert.isTrue(out.text.isWellFormed());
            if (out.kind === "assistant-text") {
              assert.equal(out.textOffset, assembled.length);
              assembled += out.text;
            } else phases.push(out.text);
          }
          cursor = state.cursor;
          if (!state.hasMore) break;
        }
        assert.equal(assembled, text);
        assert.include(phases, "approval_request");
        assert.notInclude(phases.join(" "), "PRIVATE");
        assert.equal(
          (yield* service.execute({
            ...submit,
            operation: "read",
            after: { sequence: cursor.sequence + 1_000, textOffset: 0 },
          })).gap,
          "cursor-ahead",
        );
        const cancelled = yield* service.execute({
          ...submit,
          source: { ...submit.source, turnId: "turn-2" },
          operation: "cancel",
          requestId: "cancel-2",
          expectedRunId: second.locator.runId,
        });
        assert.equal(cancelled.status, "cancelled");
        const pending = yield* Queue.unbounded<{
          readonly request: NativeAuthorRequest;
          readonly resolve: (response: NativeAuthorResponse) => void;
        }>();
        yield* Stream.fromQueue(pending).pipe(
          Stream.runForEach(({ request, resolve }) =>
            service.execute(request).pipe(
              Effect.andThen((state) =>
                Effect.sync(() => {
                  resolve({
                    version: 1,
                    requestId: request.requestId,
                    ok: true,
                    state,
                    ...(request.operation === "open-results" ? { windowId: 42 } : {}),
                  });
                }),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Effect.promise(async () => {
          const directory = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "native-author-socket-"),
          );
          const windows = HostProcess.Platform.defaultValue() === "win32";
          const address = windows
            ? `\\\\.\\pipe\\${NodePath.basename(directory)}`
            : NodePath.join(directory, "control.sock");
          let opens = 0;
          let brokerCalls = 0;
          const server = await startDesktopAppControlServer({
            address,
            directory: windows ? null : directory,
            userId: process.getuid?.(),
            onReclaimError: () => undefined,
            cancel: () => {
              brokerCalls++;
            },
            handle: async () => {
              brokerCalls++;
              throw new Error("No activation");
            },
            nativeAuthor: async (request, alive) => {
              assert.isTrue(alive());
              if (request.requestId === "oversized")
                return {
                  version: 1,
                  requestId: request.requestId,
                  ok: true,
                  state: {
                    ...waiting,
                    output: Array.from({ length: 64 }, () => ({
                      sequence: 1,
                      itemId: "oversized",
                      kind: "assistant-text" as const,
                      text: "x".repeat(8_192),
                      textOffset: 0,
                      totalTextLength: 8_192,
                      streaming: true,
                    })),
                  },
                };
              if (request.operation === "open-results") opens++;
              return new Promise((resolve) => Queue.offerUnsafe(pending, { request, resolve }));
            },
          });
          try {
            const opened = await exchange(address, {
              version: 1,
              type: "native-author",
              requestId: "open-1",
              source: submit.source,
              operation: "open-results",
            });
            assert.isTrue(opened.ok);
            if (opened.ok) {
              assert.equal(opened.state.status, "waiting");
              assert.equal(opened.windowId, 42);
            }
            assert.equal(opens, 1);
            const oversized = await exchange(address, {
              version: 1,
              type: "native-author",
              requestId: "oversized",
              source: submit.source,
              operation: "read",
            });
            assert.deepEqual(oversized, {
              version: 1,
              requestId: "oversized",
              ok: false,
              code: "response-too-large",
            });
            for (const extra of [
              { environmentId: "external" },
              { threadId: "other" },
              { credentials: "no" },
              { approved: true },
            ]) {
              const denied = await exchange(address, { ...submit, ...extra });
              assert.isFalse(denied.ok);
            }
            assert.equal(brokerCalls, 0);
          } finally {
            await server.close();
            await NodeFSP.rm(directory, { recursive: true, force: true });
          }
        });
        return first;
      });
      const first = yield* program.pipe(Effect.provide(NativeAuthor.layer));
      // Fresh service construction has no in-memory source mapping to recover from.
      const recovered = yield* Effect.flatMap(NativeAuthor.NativeAuthorService, (service) =>
        service.execute({ ...submit, operation: "read" }),
      ).pipe(Effect.provide(NativeAuthor.layer));
      assert.equal(recovered.locator.runId, first.locator.runId);
      assert.lengthOf((yield* threads.getThreadRecords(first.locator.threadId, ["runs"])).runs, 2);
      assert.isFalse(isRequest({ ...submit, operation: "approve" }));
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
