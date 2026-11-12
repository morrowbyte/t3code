// @effect-diagnostics nodeBuiltinImport:off -- The fixture replaces only the captured native child handle, never starts a process or SDK turn.
import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import { it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { expect, vi } from "vite-plus/test";
import { makeCursorSdkProcessRunner } from "./CursorSdkProcess.ts";
import { isCursorAgentSdkRunnerError, type CursorAgentSdkOpenInput } from "./CursorAgentSdk.ts";
import type { CursorSdkWorkerMessage } from "./CursorSdkTransport.ts";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));

function setup() {
  const workers: Array<{
    readonly arguments: ReadonlyArray<string>;
    readonly executable: string;
    readonly environment: NodeJS.ProcessEnv | undefined;
    readonly operations: string[];
    readonly kills: string[];
    readonly crash: () => void;
    readonly holdExit: () => void;
    readonly finishExit: () => void;
    readonly closeAcknowledged: Deferred.Deferred<void>;
  }> = [];
  let createResult: string | undefined;
  native.spawn.mockReset();
  native.spawn.mockImplementation(
    (executable: string, args: string[], options: NodeChildProcess.SpawnOptions) => {
      const events = new NodeEvents.EventEmitter();
      const operations: string[] = [];
      const kills: string[] = [];
      let connected = true;
      let holdExit = false;
      const closeAcknowledged = Deferred.makeUnsafe<void>();
      let agentId = "";
      const exit = (code: number | null, signal: string | null) => {
        if (!connected) return;
        connected = false;
        events.emit("exit", code, signal);
        events.emit("disconnect");
      };
      const child = Object.assign(events, {
        pid: 200 + workers.length,
        send: (message: CursorSdkWorkerMessage, callback: (error: Error | null) => void) => {
          if (message.type !== "request") throw new Error("Unexpected proxy fixture message.");
          operations.push(message.method);
          let value: unknown;
          if (message.method === "open") {
            agentId =
              createResult ??
              message.input.agentId ??
              message.input.options.agentId ??
              `created-${workers.length}`;
            value = { agentId };
          } else if (message.method === "send") {
            value = { agentId, runId: `run-${message.input.sendId}` };
          } else if (message.method === "messages") value = [];
          queueMicrotask(() => {
            callback(null);
            events.emit("message", { type: "response", id: message.id, value });
            if (message.method === "close") {
              Deferred.doneUnsafe(closeAcknowledged, Effect.void);
              if (!holdExit) queueMicrotask(() => exit(0, null));
            }
          });
          return true;
        },
        disconnect: () => exit(0, null),
        kill: (signal: string) => {
          kills.push(signal);
          exit(null, signal);
          return true;
        },
      });
      Object.defineProperty(child, "connected", { get: () => connected });
      workers.push({
        arguments: args,
        executable,
        environment: options.env,
        operations,
        kills,
        crash: () => exit(1, null),
        holdExit: () => {
          holdExit = true;
        },
        finishExit: () => exit(0, null),
        closeAcknowledged,
      });
      return child as unknown as NodeChildProcess.ChildProcess;
    },
  );
  return {
    workers,
    returnAgent: (id: string) => {
      createResult = id;
    },
  };
}

function resume(agentId: string, owner: string): CursorAgentSdkOpenInput {
  return {
    operation: "resume",
    agentId,
    options: {},
    threadId: ThreadId.make(owner),
    providerSessionId: ProviderSessionId.make(`${owner}-session`),
  };
}

function expectCollision(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected an ownership collision.");
  const error = Cause.squash(exit.cause);
  expect(isCursorAgentSdkRunnerError(error)).toBe(true);
  if (!isCursorAgentSdkRunnerError(error)) throw new Error("Expected a runner error.");
  expect(error.cause).toMatchObject({ code: "CURSOR_AGENT_ALREADY_OPEN" });
}

const layerTest = Layer.mergeAll(
  Layer.succeed(HostProcess.Environment, {
    T3CODE_THREAD_ID: "server-owner",
    TEST_MARKER: "server",
  }),
  Layer.succeed(HostProcess.IsExecutable, false),
);

it.layer(layerTest)("Cursor SDK session process ownership", (it) => {
  it.effect(
    "leases before resume/create, releases only its own exited worker, and rejects pending waits on crash",
    () =>
      Effect.gen(function* () {
        const fixture = setup();
        const serverEnvironment = yield* HostProcess.Environment;
        const runner = yield* makeCursorSdkProcessRunner(() => undefined);
        expect(fixture.workers).toHaveLength(0);
        const a = yield* runner.open({
          ...resume("native-a", "owner-a"),
          operation: "create",
          options: { agentId: "native-a", idempotencyKey: "create-a" },
          environment: { T3CODE_THREAD_ID: "stale", TEST_MARKER: "a" },
        });
        expect(fixture.workers[0]?.environment).toMatchObject({
          T3CODE_THREAD_ID: "owner-a",
          TEST_MARKER: "a",
          ELECTRON_RUN_AS_NODE: "1",
        });
        expectCollision(yield* Effect.exit(runner.open(resume("native-a", "foreign-owner"))));
        expectCollision(
          yield* Effect.exit(
            runner.open({
              ...resume("native-b", "owner-b"),
              operation: "create",
              options: { idempotencyKey: "create-a" },
            }),
          ),
        );
        expect(fixture.workers).toHaveLength(1);
        expect(fixture.workers[0]?.operations).toEqual(["open"]);
        const b = yield* runner.open(resume("native-b", "owner-b"));
        const bRun = yield* b.send({ message: "fixture only" });
        expect(fixture.workers[1]?.environment?.T3CODE_THREAD_ID).toBe("owner-b");
        expect(serverEnvironment).toEqual({
          T3CODE_THREAD_ID: "server-owner",
          TEST_MARKER: "server",
        });
        fixture.workers[0]!.holdExit();
        yield* Effect.gen(function* () {
          const closing = yield* a.close.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(fixture.workers[0]!.closeAcknowledged);
          expectCollision(yield* Effect.exit(runner.open(resume("native-a", "before-exit"))));
          fixture.workers[0]!.finishExit();
          yield* Fiber.join(closing);
        }).pipe(Effect.ensuring(Effect.sync(() => fixture.workers[0]!.finishExit())));
        const replacementA = yield* runner.open(resume("native-a", "replacement-a"));
        yield* a.close;
        expectCollision(yield* Effect.exit(runner.open(resume("native-a", "late-a"))));
        fixture.workers[1]!.crash();
        expect(Exit.isFailure(yield* Effect.exit(bRun.wait))).toBe(true);
        const replacementB = yield* runner.open(resume("native-b", "replacement-b"));
        yield* b.close;
        expectCollision(yield* Effect.exit(runner.open(resume("native-b", "late-b"))));
        expect(fixture.workers).toHaveLength(4);
        expect(fixture.workers.every((worker) => worker.kills.length === 0)).toBe(true);
        yield* replacementA.close;
        yield* replacementB.close;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "does not close or cancel a foreign native agent when create unexpectedly returns its id",
    () =>
      Effect.gen(function* () {
        const fixture = setup();
        const runner = yield* makeCursorSdkProcessRunner(() => undefined);
        const a = yield* runner.open(resume("native-a", "owner-a"));
        fixture.returnAgent("native-a");
        expectCollision(
          yield* Effect.exit(
            runner.open({
              operation: "create",
              options: { idempotencyKey: "new-create" },
              threadId: ThreadId.make("owner-b"),
              providerSessionId: ProviderSessionId.make("owner-b-session"),
            }),
          ),
        );
        expect(fixture.workers[1]?.kills).toEqual(["SIGKILL"]);
        expect(fixture.workers[1]?.operations).toEqual(["open"]);
        expect(fixture.workers[0]?.operations).toEqual(["open"]);
        expectCollision(yield* Effect.exit(runner.open(resume("native-a", "owner-c"))));
        yield* a.close;
      }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])("uses the selected host executable with SEA=%s", (isExecutable) =>
    Effect.gen(function* () {
      const fixture = setup();
      const runner = yield* makeCursorSdkProcessRunner(() => undefined);
      const session = yield* runner.open(resume("native-a", "owner-a"));
      expect(fixture.workers[0]?.executable).toBe("/fixture/host-executable");
      const args = fixture.workers[0]?.arguments;
      if (isExecutable) expect(args).toEqual(["__cursor-sdk-worker"]);
      else {
        expect(args?.[0]).toBe("--experimental-strip-types");
        expect(args?.at(-1)).toMatch(/apps[/\\]server[/\\]src[/\\]cursor-sdk-worker\.ts$/);
      }
      yield* session.close;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.ExecutablePath, "/fixture/host-executable"),
          Layer.succeed(HostProcess.IsExecutable, isExecutable),
        ),
      ),
    ),
  );
});
