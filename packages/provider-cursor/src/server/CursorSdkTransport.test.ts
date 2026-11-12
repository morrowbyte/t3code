// @effect-diagnostics nodeBuiltinImport:off -- The fixture exercises the same V8 serialization as native process IPC.
import * as NodeV8 from "node:v8";
import type { AgentOptions, RunResult } from "@cursor/sdk";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  CursorAgentSdkRunner,
  CursorAgentSdkRunnerError,
  type CursorAgentSdkSession,
} from "./CursorAgentSdk.ts";
import { CursorSdkCallbacks, cursorSdkWorkerOptions } from "./CursorSdkCallbacks.ts";
import { CursorSdkRemoteError } from "./CursorSdkErrors.ts";
import { makeCursorSdkWorkerSession } from "./CursorSdkWorker.ts";
import {
  CursorSdkTransport,
  type CursorSdkIpcEndpoint,
  type CursorSdkWorkerMessage,
} from "./CursorSdkTransport.ts";

function ipcPair() {
  const sides = [0, 1].map(() => ({
    messages: new Set<(message: CursorSdkWorkerMessage) => void>(),
    disconnects: new Set<() => void>(),
  }));
  const endpoint = (index: number): CursorSdkIpcEndpoint => ({
    send: (message, callback) => {
      const copy = NodeV8.deserialize(NodeV8.serialize(message)) as CursorSdkWorkerMessage;
      queueMicrotask(() => {
        for (const listener of sides[1 - index]!.messages) listener(copy);
        callback(null);
      });
    },
    onMessage: (listener) => {
      sides[index]!.messages.add(listener);
      return () => {
        sides[index]!.messages.delete(listener);
      };
    },
    onDisconnect: (listener) => {
      sides[index]!.disconnects.add(listener);
      return () => {
        sides[index]!.disconnects.delete(listener);
      };
    },
  });
  return {
    parent: endpoint(0),
    worker: endpoint(1),
    disconnect: () => {
      for (const side of sides) for (const listener of side.disconnects) listener();
    },
  };
}

function workerFixture(
  owner: string,
  session: CursorAgentSdkSession,
  openError?: CursorAgentSdkRunnerError,
) {
  const pair = ipcPair();
  const completed = Promise.withResolvers<CursorSdkWorkerMessage>();
  const delta = Promise.withResolvers<void>();
  const releaseDelta = Promise.withResolvers<void>();
  const parent = new CursorSdkTransport(
    pair.parent,
    async (message) => {
      if (message.type === "delta") {
        delta.resolve();
        await releaseDelta.promise;
        return;
      }
      if (message.type === "completed" || message.type === "runFailed") {
        completed.resolve(message);
        return;
      }
      throw new Error("Unexpected worker fixture message.");
    },
    () => undefined,
  );
  const transport: CursorSdkTransport = new CursorSdkTransport(
    pair.worker,
    async (message) => {
      if (message.type !== "request") throw new Error("Unexpected parent fixture message.");
      return worker.handle(message);
    },
    () => {
      void worker.close().catch(() => undefined);
    },
  );
  const worker = makeCursorSdkWorkerSession(
    CursorAgentSdkRunner.of({
      open: () => (openError === undefined ? Effect.succeed(session) : Effect.fail(openError)),
      assertComplete: Effect.void,
    }),
    transport,
    owner,
  );
  const open = () =>
    parent.request("open", {
      operation: "resume",
      agentId: session.agentId,
      threadId: owner,
      providerSessionId: `${owner}-session`,
      options: {},
    });
  return { pair, parent, transport, worker, completed, delta, releaseDelta, open };
}

describe("Cursor SDK process transport", () => {
  it("preserves callback tools, send overrides, stores and subagent factories through V8", async () => {
    const callbacks = new CursorSdkCallbacks();
    const scope = callbacks.scope();
    const seen: unknown[] = [];
    const store: NonNullable<NonNullable<AgentOptions["local"]>["store"]> = {
      agents: {
        get: async (input) => {
          seen.push(input);
          return null;
        },
        create: async ({ agent }) => agent,
        update: async ({ agent }) => agent,
        delete: async () => {},
        list: async () => ({ items: [] }),
      },
      runs: {
        get: async () => null,
        create: async ({ run }) => run,
        update: async ({ run }) => run,
        delete: async () => {},
        list: async () => ({ items: [] }),
      },
      checkpoints: {
        get: async () => new Uint8Array([1, 2]),
        create: async (input) => {
          seen.push(input.data);
        },
        update: async () => {},
        delete: async () => {},
        list: async () => ({ items: [] }),
      },
      runEvents: {
        append: async (input) => ({
          ...input,
          seq: 0,
          offset: "0",
          payload: input.payload,
          payloadRef: null,
          idempotencyKey: null,
          createdAt: 0,
        }),
        list: async () => ({ items: [] }),
        delete: async () => {},
      },
    };
    const input: AgentOptions = {
      model: { id: "test-model", params: [{ id: "reasoning", value: "high" }], maxMode: true },
      tools: ["shell", "mcp"],
      disallowedTools: ["delete"],
      systemPrompt: "test-system",
      name: "test-name",
      agentId: "test-agent",
      idempotencyKey: "test-key",
      mode: "plan",
      agents: { helper: { description: "test", prompt: "test", model: "inherit" } },
      mcpServers: { test: { type: "stdio", command: "test", env: { MARKER: "test" } } },
      local: {
        cwd: "/workspace",
        dirs: ["/extra"],
        autoReview: true,
        settingSources: ["project"],
        sandboxOptions: { enabled: false },
        enableAgentRetries: false,
        store,
        customTools: {
          test: {
            description: "test",
            inputSchema: { type: "object" },
            execute: (args, context) => {
              seen.push(context);
              return args;
            },
          },
        },
        subagentInherit: {
          reportedWorkspacePath: "/reported",
          resourceProviderOptions: async (context) => {
            seen.push(context);
            return {
              suppressDefaultShellExecutor: true,
              overrideShellExecutor: { execute: (...args) => ({ args }) },
            };
          },
        },
      },
    };
    const wire = NodeV8.deserialize(NodeV8.serialize(scope.agentOptions(input)));
    const options = cursorSdkWorkerOptions(async (key, payload) =>
      NodeV8.deserialize(
        NodeV8.serialize(
          await callbacks.invoke(key, NodeV8.deserialize(NodeV8.serialize(payload))),
        ),
      ),
    );
    const restored = options.agentOptions(wire);
    expect({ ...restored, local: undefined }).toEqual({ ...input, local: undefined });
    expect(restored.local?.dirs).toEqual(["/extra"]);
    expect(await restored.local?.store?.agents.get({ agentId: "test-agent" })).toBeNull();
    expect(
      await restored.local?.store?.checkpoints.get({ agentId: "test-agent", blobId: "blob" }),
    ).toEqual(new Uint8Array([1, 2]));
    expect(
      await restored.local?.customTools?.test?.execute(
        { value: 1 },
        { toolCallId: "call-a", sessionId: "child-a" },
      ),
    ).toEqual({ value: 1 });
    const factory = restored.local?.subagentInherit?.resourceProviderOptions;
    expect(typeof factory).toBe("function");
    if (typeof factory !== "function") throw new Error("Missing factory.");
    const fields = await factory({ sessionId: "child-a" });
    expect(fields.suppressDefaultShellExecutor).toBe(true);
    expect(await fields.overrideShellExecutor?.execute()).toEqual({ args: [] });
    const send = options.sendOptions(
      NodeV8.deserialize(
        NodeV8.serialize(
          scope.sendOptions({
            model: { id: "send-model" },
            mode: "agent",
            idempotencyKey: "send-key",
            onStep: async (step) => {
              seen.push(step);
            },
            local: {
              force: true,
              customTools: {
                test: {
                  execute: () => {
                    throw Object.assign(new Error("tool failed"), { code: "TOOL_FAILED" });
                  },
                },
              },
            },
          }),
        ),
      ),
    );
    expect(send.local?.force).toBe(true);
    expect(send.model).toEqual({ id: "send-model" });
    const step = { step: { type: "assistantMessage" as const, message: { text: "step" } } };
    await send.onStep?.(step);
    expect(seen).toContainEqual(step);
    await expect(send.local?.customTools?.test?.execute({}, {})).rejects.toMatchObject({
      code: "TOOL_FAILED",
    });
    expect(seen).toContainEqual({ toolCallId: "call-a", sessionId: "child-a" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const cancellable = scope.sendOptions({
      local: {
        customTools: {
          pending: {
            execute: () => {
              entered.resolve();
              return release.promise;
            },
          },
        },
      },
    });
    const controller = new AbortController();
    const pending = callbacks.invoke(
      cancellable.local!.customTools!.pending!.execute,
      [{}, {}],
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    controller.abort();
    await rejected;
    release.resolve("late result");
    scope.close();
    await expect(restored.local?.customTools?.test?.execute({}, {})).rejects.toThrow(
      "closed run or session",
    );
  });

  it("accepts cancel while an early delta is blocked, completes the run, and closes once", async () => {
    const finished = Promise.withResolvers<RunResult>();
    let cancelled = 0;
    let closed = 0;
    const fixture = workerFixture("owner-a", {
      agentId: "agent-a",
      send: (input) =>
        Effect.gen(function* () {
          yield* (input.onDelta?.({ type: "text-delta", text: "early" }) ?? Effect.void).pipe(
            Effect.orDie,
          );
          return {
            agentId: "agent-a",
            runId: "run-a",
            wait: Effect.promise(() => finished.promise),
            cancel: Effect.sync(() => {
              cancelled += 1;
              finished.resolve({ id: "run-a", status: "cancelled" });
            }),
          };
        }),
      listMessages: Effect.succeed([]),
      close: Effect.sync(() => {
        closed += 1;
      }),
    });
    try {
      await fixture.open();
      const starting = fixture.parent.request("send", {
        sendId: 1,
        message: { text: "hello", images: [{ data: "test", mimeType: "image/png" }] },
        options: { mode: "plan", local: { force: true } },
      });
      await fixture.delta.promise;
      await fixture.parent.request("cancel", { sendId: 1 });
      fixture.releaseDelta.resolve();
      expect(await starting).toEqual({ runId: "run-a", agentId: "agent-a" });
      expect(await fixture.completed.promise).toMatchObject({
        type: "completed",
        result: { status: "cancelled" },
      });
      expect(cancelled).toBe(1);
      await Promise.all([
        fixture.parent.request("close", undefined),
        fixture.parent.request("close", undefined),
      ]);
      expect(closed).toBe(1);
    } finally {
      fixture.pair.disconnect();
    }
  });

  it("rejects a different owner or second open and isolates IPC loss from another session", async () => {
    const blocked = Promise.withResolvers<ReadonlyArray<never>>();
    const entered = Promise.withResolvers<void>();
    const session = (agentId: string): CursorAgentSdkSession => ({
      agentId,
      send: () => Effect.die("unused"),
      listMessages: Effect.succeed([]),
      close: Effect.void,
    });
    const a = workerFixture("owner-a", {
      ...session("agent-a"),
      listMessages: Effect.promise(() => {
        entered.resolve();
        return blocked.promise;
      }),
    });
    const b = workerFixture("owner-b", session("agent-b"));
    try {
      await expect(
        a.parent.request("open", {
          operation: "resume",
          threadId: "owner-b",
          providerSessionId: "foreign",
          options: {},
        }),
      ).rejects.toThrow("canonical owner");
      await a.open();
      await b.open();
      await expect(a.open()).rejects.toThrow("canonical owner or session");
      const pending = a.parent.request("messages", undefined);
      const rejected = expect(pending).rejects.toThrow("disconnected");
      await entered.promise;
      a.pair.disconnect();
      await rejected;
      expect(await b.parent.request("messages", undefined)).toEqual([]);
      await b.parent.request("close", undefined);
    } finally {
      blocked.resolve([]);
      a.pair.disconnect();
      b.pair.disconnect();
    }
  });

  it("terminates pending requests on nonserializable data and preserves error code, status and causes", async () => {
    const pair = ipcPair();
    const parent = new CursorSdkTransport(
      pair.parent,
      async () => undefined,
      () => undefined,
    );
    const worker = new CursorSdkTransport(
      pair.worker,
      async () => {
        throw new CursorSdkRemoteError({
          name: "RateLimitError",
          message: "limited",
          kinds: ["CursorSdkError"],
          code: "PRO_USER_USAGE_LIMIT",
          status: 429,
          cause: { name: "AbortError", message: "cancelled", kinds: [] },
        });
      },
      () => undefined,
    );
    try {
      await expect(parent.request("messages", undefined)).rejects.toMatchObject({
        name: "RateLimitError",
        code: "PRO_USER_USAGE_LIMIT",
        status: 429,
        cause: { name: "AbortError" },
      });
      await expect(parent.callback(1, () => undefined)).rejects.toThrow();
      await expect(parent.request("messages", undefined)).rejects.toThrow();
    } finally {
      pair.disconnect();
      worker.fail(new Error("fixture closed"));
    }

    const silent = ipcPair();
    const bounded = new CursorSdkTransport(
      silent.parent,
      async () => undefined,
      () => undefined,
    );
    const pending = Array.from({ length: 257 }, () => bounded.request("messages", undefined));
    const settled = await Promise.allSettled(pending);
    expect(
      settled.every(
        (result) =>
          result.status === "rejected" && result.reason.message.includes("pending IPC limit"),
      ),
    ).toBe(true);
    silent.disconnect();
  });

  it("keeps open failure details and failed close receipts without reopening or closing twice", async () => {
    let closes = 0;
    const session: CursorAgentSdkSession = {
      agentId: "failure-agent",
      send: () => Effect.die("unused"),
      listMessages: Effect.succeed([]),
      close: Effect.sync(() => {
        closes += 1;
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new CursorAgentSdkRunnerError({
              method: "agent.close",
              cause: Object.assign(new Error("close failed"), { code: "CLOSE_FAILED" }),
            }),
          ),
        ),
      ),
    };
    const failedOpen = workerFixture(
      "failed-open",
      session,
      new CursorAgentSdkRunnerError({
        method: "agent.resume",
        cause: Object.assign(new Error("missing SDK chunk"), { code: "MODULE_NOT_FOUND" }),
      }),
    );
    const failedClose = workerFixture("failed-close", session);
    try {
      await expect(failedOpen.open()).rejects.toMatchObject({
        method: "agent.resume",
        cause: { code: "MODULE_NOT_FOUND" },
      });
      await expect(failedOpen.open()).rejects.toThrow("canonical owner or session");
      await failedOpen.parent.request("close", undefined);
      expect(closes).toBe(0);
      await failedClose.open();
      await expect(failedClose.parent.request("close", undefined)).rejects.toMatchObject({
        method: "agent.close",
        cause: { code: "CLOSE_FAILED" },
      });
      await expect(failedClose.parent.request("close", undefined)).rejects.toMatchObject({
        method: "agent.close",
      });
      expect(closes).toBe(1);
    } finally {
      failedOpen.pair.disconnect();
      failedClose.pair.disconnect();
    }
  });
});
