import * as NodeServices from "@effect/platform-node/NodeServices";
import type { InteractionUpdate } from "@cursor/sdk";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { vi } from "vite-plus/test";

import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: {
        readonly onDelta?: (input: { readonly update: InteractionUpdate }) => Promise<void>;
      },
    ) => {
      runOperations.push("run.start");
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "text-delta",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(async () => {
    runOperations.push("agent.listRuns");
    return {
      items: staleRunActive ? [{ id: "run-stale", status: "running" }] : [],
    };
  });
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({
    Agent: {
      create: cursorSdkMock.create,
      resume: cursorSdkMock.resume,
      listRuns: cursorSdkMock.listRuns,
      cancelRun: cursorSdkMock.cancelRun,
      messages: {
        list: vi.fn(async () => []),
      },
    },
    createAgentPlatform: vi.fn(),
  }),
  loadCursorSqlite: () => ({ SqliteLocalAgentStore: { open: vi.fn() } }),
}));

const layerTest = Layer.effect(
  CursorAgentSdk.CursorAgentSdkRunner,
  CursorAgentSdk.makeCursorAgentSdkRunner(
    () => (event) =>
      Effect.sync(() => {
        if (event.payload.type === "agent.close")
          cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
      }),
  ),
).pipe(Layer.provide(CursorSdk.layer), Layer.provide(NodeServices.layer));

describe("CursorAgentSdkRunner", () => {
  it.effect("constructs without loading and reports first-use load failures as runner errors", () =>
    Effect.gen(function* () {
      const failure = new Error("missing SDK chunk");
      const load = vi.fn(() => {
        throw failure;
      });
      const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => undefined).pipe(
        Effect.provideService(CursorSdk.CursorSdk, {
          load,
          loadSqlite: () => {
            throw new Error("unused SQLite");
          },
        }),
      );
      assert.strictEqual(load.mock.calls.length, 0);
      const result = yield* runner
        .open({
          operation: "create",
          options: {},
          threadId: ThreadId.make("lazy-load"),
          providerSessionId: ProviderSessionId.make("lazy-load"),
        })
        .pipe(Effect.exit);
      assert(Exit.isFailure(result));
      assert.deepStrictEqual(
        Cause.squash(result.cause),
        new CursorAgentSdk.CursorAgentSdkRunnerError({
          method: "agent.create",
          cause: failure,
        }),
      );
      assert.strictEqual(load.mock.calls.length, 1);
    }),
  );

  it.effect("retries a resumed send after cancelling its abandoned local run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.listRuns.mockClear();
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStaleRunActive(true);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-stale-run-test",
        ),
      });
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, [
        "run.start",
        "agent.listRuns",
        "agent.cancelRun",
        "run.start",
      ]);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd(), limit: 1 },
      ]);
      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
        "run-stale",
        {
          runtime: "local",
          cwd: process.cwd(),
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("delivers early deltas in order and fails wait on the final callback failure", () =>
    Effect.gen(function* () {
      cursorSdkMock.setStaleRunActive(false);
      cursorSdkMock.send.mockImplementationOnce(async (_message, options) => {
        for (const text of ["first", "last"])
          await options.onDelta?.({ update: { type: "text-delta", text } });
        return {
          id: "ordered-run",
          agentId: "ordered-agent",
          wait: cursorSdkMock.runWait,
          cancel: cursorSdkMock.runCancel,
        };
      });
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("ordered"),
        providerSessionId: ProviderSessionId.make("ordered"),
      });
      const updates: string[] = [];
      const callbackError = new CursorAgentSdk.CursorAgentSdkRunnerError({
        method: "onDelta",
        cause: new Error("callback failed"),
      });
      const run = yield* session.send({
        message: "test",
        onDelta: (update) =>
          Effect.gen(function* () {
            if (update.type !== "text-delta") return;
            updates.push(update.text);
            if (update.text === "last") {
              return yield* callbackError;
            }
          }),
      });
      assert.deepStrictEqual(updates, ["first", "last"]);
      const result = yield* Effect.exit(run.wait);
      assert(Exit.isFailure(result));
      assert.strictEqual(Cause.squash(result.cause), callbackError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("bounds deltas emitted before the SDK returns a run handle", () =>
    Effect.gen(function* () {
      cursorSdkMock.setStaleRunActive(false);
      cursorSdkMock.send.mockImplementationOnce(async (_message, options) => {
        for (let index = 0; index < 257; index++)
          await options.onDelta?.({ update: { type: "text-delta", text: "delta" } });
        return {
          id: "overflow-run",
          agentId: "overflow-agent",
          wait: cursorSdkMock.runWait,
          cancel: cursorSdkMock.runCancel,
        };
      });
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("overflow"),
        providerSessionId: ProviderSessionId.make("overflow"),
      });
      const result = yield* Effect.exit(session.send({ message: "test" }));
      assert(Exit.isFailure(result));
      const failure = Cause.squash(result.cause);
      assert(CursorAgentSdk.isCursorAgentSdkRunnerError(failure));
      assert.strictEqual(failure.method, "run.start");
    }).pipe(Effect.provide(layerTest)),
  );
});
