import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const Frame = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const selection = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "requested-eval-model",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "ultrafast" },
  ],
};
const tool = {
  name: "boat_command",
  description: "Run one command on Boat.",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
};
const output = {
  success: true,
  contentItems: [{ type: "inputText" as const, text: "boat result" }],
};

const makeHarness = Effect.fn("CodexEvaluationTest.makeHarness")(function* (
  isolation: "empty" | "inherited" = "empty",
) {
  const inbound = yield* Queue.unbounded<Uint8Array>();
  const responses = yield* Queue.unbounded<typeof Frame.Type>();
  const started = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const methods: string[] = [];
  const replies: Array<typeof Frame.Type> = [];
  let cwd = "";
  let threadStart: unknown;
  let turnStart: unknown;
  const emit = (frame: unknown) =>
    Queue.offer(inbound, new TextEncoder().encode(`${encodeFrame(frame)}\n`));
  const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
    instanceId: selection.instanceId,
    settings: Schema.decodeSync(CodexSettings)({}),
    environment: {},
    resolveRuntime: Effect.succeed({
      config: Schema.decodeSync(CodexSettings)({ binaryPath: "resolved-codex" }),
      environment: { EVALUATION_RUNTIME: "resolved" },
      revision: "test-runtime",
    }),
    clientFactory: {
      open: (input) =>
        Effect.gen(function* () {
          cwd = input.runtimePolicy.cwd!;
          assert.equal(input.cwd, cwd);
          assert.notEqual(cwd, process.cwd());
          assert.equal(input.settings.binaryPath, "resolved-codex");
          assert.equal(input.environment.EVALUATION_RUNTIME, "resolved");
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          return yield* CodexClient.make(
            Stdio.make({
              args: Effect.succeed([]),
              stdin: Stream.fromQueue(inbound),
              stderr: () => Sink.drain,
              stdout: () =>
                Sink.forEach((chunk: string | Uint8Array) =>
                  Effect.gen(function* () {
                    const frame = decodeFrame(
                      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
                    );
                    if (!frame.method) {
                      replies.push(frame);
                      yield* Queue.offer(responses, frame);
                      return;
                    }
                    methods.push(frame.method);
                    const reply = (result: unknown) => emit({ id: frame.id, result });
                    switch (frame.method) {
                      case "initialize":
                        yield* reply({ userAgent: "fixture" });
                        break;
                      case "initialized":
                        break;
                      case "config/read":
                        yield* reply({ config: { mcp_servers: { inherited: { enabled: true } } } });
                        break;
                      case "thread/start":
                        threadStart = frame.params;
                        yield* reply({
                          model: selection.model,
                          reasoningEffort: "high",
                          serviceTier: "ultrafast",
                          approvalPolicy: "never",
                          sandbox: { type: "readOnly", networkAccess: false },
                          runtimeWorkspaceRoots: [],
                          thread: { id: "private-eval", environments: [] },
                        });
                        break;
                      case "mcpServerStatus/list":
                        yield* reply({
                          data:
                            isolation === "empty"
                              ? []
                              : [
                                  {
                                    tools: { inherited_tool: {} },
                                    resources: [],
                                    resourceTemplates: [],
                                  },
                                ],
                          nextCursor: null,
                        });
                        break;
                      case "turn/start":
                        turnStart = frame.params;
                        yield* reply({ turn: { id: "eval-turn" } });
                        yield* Deferred.succeed(started, undefined);
                        break;
                      case "turn/interrupt":
                      case "thread/archive":
                        yield* reply({});
                        break;
                      case "thread/unsubscribe":
                        yield* reply({ status: "unsubscribed" });
                        break;
                      default:
                        assert.fail(`Unexpected evaluation request: ${frame.method}`);
                    }
                  }).pipe(Effect.orDie),
                ),
            }),
          );
        }),
    },
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig("evaluation").pipe(
      Effect.orDie,
    ),
  });
  return {
    adapter,
    emit,
    inbound,
    responses,
    replies,
    started,
    closed,
    methods,
    cwd: () => cwd,
    threadStart: () => threadStart,
    turnStart: () => turnStart,
  };
});

it.effect("routes an isolated native eval tool call only after its callback resolves", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const callback = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2EvaluationToolCall>();
    const release = yield* Deferred.make<typeof output>();
    const evaluation = yield* harness.adapter.evaluate!({
      modelSelection: selection,
      instructions: "Evaluate using Boat.",
      input: "Run the task.",
      tools: [tool],
      onToolCall: (call) =>
        Deferred.succeed(callback, call).pipe(Effect.andThen(Deferred.await(release))),
    }).pipe(Effect.forkChild);
    yield* Deferred.await(harness.started).pipe(Effect.raceFirst(Fiber.join(evaluation)));
    assert.deepInclude(harness.threadStart(), {
      model: selection.model,
      serviceTier: "ultrafast",
      ephemeral: true,
      environments: [],
      runtimeWorkspaceRoots: [],
      baseInstructions: "Evaluate using Boat.",
      dynamicTools: [{ ...tool, type: "function" }],
    });
    const start = harness.threadStart() as { config: Record<string, unknown> };
    assert.deepInclude(start.config, {
      mcp_servers: { inherited: { enabled: false } },
      model_reasoning_effort: "high",
      web_search: "disabled",
    });
    assert.deepInclude(harness.turnStart(), {
      model: selection.model,
      effort: "high",
      serviceTier: "ultrafast",
    });
    yield* harness.emit({
      id: "foreign-rpc",
      method: "item/tool/call",
      params: {
        threadId: "other-thread",
        turnId: "eval-turn",
        callId: "foreign",
        tool: tool.name,
        arguments: {},
      },
    });
    const foreign = yield* Queue.take(harness.responses);
    assert.equal(foreign.id, "foreign-rpc");
    assert.deepInclude(foreign.result, { success: false });
    yield* harness.emit({
      method: "item/completed",
      params: {
        threadId: "private-eval",
        turnId: "eval-turn",
        completedAtMs: 0,
        item: {
          type: "agentMessage",
          id: "commentary",
          phase: "commentary",
          text: "Checking the fixture.",
        },
      },
    });
    yield* harness.emit({
      id: "original-rpc-id",
      method: "item/tool/call",
      params: {
        threadId: "private-eval",
        turnId: "eval-turn",
        callId: "call-1",
        namespace: "functions",
        tool: tool.name,
        arguments: { command: "pwd" },
      },
    });
    assert.deepEqual(
      yield* Deferred.await(callback).pipe(Effect.raceFirst(Fiber.join(evaluation))),
      {
        callId: "call-1",
        namespace: "functions",
        name: "boat_command",
        arguments: { command: "pwd" },
        visibleText: "Checking the fixture.",
      },
    );
    assert.lengthOf(harness.replies, 1);
    yield* Deferred.succeed(release, output);
    assert.deepEqual(yield* Queue.take(harness.responses), {
      id: "original-rpc-id",
      result: output,
    });
    yield* harness.emit({
      method: "item/completed",
      params: {
        threadId: "private-eval",
        turnId: "eval-turn",
        completedAtMs: 0,
        item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "Evaluated." },
      },
    });
    yield* harness.emit({
      method: "turn/completed",
      params: {
        threadId: "private-eval",
        turn: { id: "eval-turn", items: [], status: "completed" },
      },
    });
    assert.deepEqual(yield* Fiber.join(evaluation), {
      text: "Evaluated.",
      visibleText: "Checking the fixture.\n\nEvaluated.",
    });
    yield* Deferred.await(harness.closed);
    assert.include(harness.methods, "thread/archive");
    assert.include(harness.methods, "thread/unsubscribe");
    assert.notInclude(harness.methods, "turn/interrupt");
    assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(harness.cwd()));
  }).pipe(
    Effect.scoped,
    Effect.provide([
      NodeServices.layer,
      NodeCrypto.layer,
      IdAllocator.layer,
      McpProviderSessions.layer,
    ]),
  ),
);

it.effect.each(["interrupt", "completed", "native-error", "transport-end"] as const)(
  "releases the native eval and its pending callback on %s",
  (ending) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const entered = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const evaluation = yield* harness.adapter.evaluate!({
        modelSelection: selection,
        instructions: "Evaluate.",
        input: "Run.",
        tools: [tool],
        onToolCall: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(harness.started).pipe(Effect.raceFirst(Fiber.join(evaluation)));
      yield* harness.emit({
        id: "pending-rpc",
        method: "item/tool/call",
        params: {
          threadId: "private-eval",
          turnId: "eval-turn",
          callId: "pending",
          tool: tool.name,
          arguments: {},
        },
      });
      yield* Deferred.await(entered).pipe(Effect.raceFirst(Fiber.join(evaluation)));
      if (ending === "interrupt") yield* Fiber.interrupt(evaluation);
      else if (ending === "transport-end") yield* Queue.end(harness.inbound);
      else if (ending === "native-error")
        yield* harness.emit({
          method: "error",
          params: {
            threadId: "private-eval",
            turnId: "eval-turn",
            willRetry: false,
            error: { message: "failed" },
          },
        });
      else
        yield* harness.emit({
          method: "turn/completed",
          params: {
            threadId: "private-eval",
            turn: { id: "eval-turn", items: [], status: "completed" },
          },
        });
      assert.isTrue(Exit.isFailure(yield* Fiber.await(evaluation)));
      yield* Deferred.await(stopped);
      yield* Deferred.await(harness.closed);
      if (ending !== "transport-end") {
        assert.include(harness.methods, "thread/archive");
        assert.include(harness.methods, "thread/unsubscribe");
      }
      assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(harness.cwd()));
    }).pipe(
      Effect.scoped,
      Effect.provide([
        NodeServices.layer,
        NodeCrypto.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
      ]),
    ),
);

it.effect("refuses inherited MCP capabilities before starting an evaluation turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness("inherited");
    const error = yield* harness.adapter.evaluate!({
      modelSelection: selection,
      instructions: "Evaluate.",
      input: "Run.",
      tools: [tool],
      onToolCall: () => Effect.die("No tool may run before isolation passes."),
    }).pipe(Effect.flip);
    assert.instanceOf(error, ProviderAdapter.ProviderAdapterEvaluationError);
    assert.notInclude(harness.methods, "turn/start");
    assert.include(harness.methods, "thread/archive");
    assert.include(harness.methods, "thread/unsubscribe");
  }).pipe(
    Effect.scoped,
    Effect.provide([
      NodeServices.layer,
      NodeCrypto.layer,
      IdAllocator.layer,
      McpProviderSessions.layer,
    ]),
  ),
);
