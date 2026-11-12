// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Native process/IPC ownership and shutdown deadlines live at this adapter boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import type { InteractionUpdate, RunResult } from "@cursor/sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  CursorAgentSdkRunner,
  CursorAgentSdkRunnerError,
  type CursorAgentSdkOpenInput,
  type CursorAgentSdkProtocolLogger,
  type CursorAgentSdkSession,
} from "./CursorAgentSdk.ts";
import { CursorSdkCallbacks, type CursorSdkCallbackScope } from "./CursorSdkCallbacks.ts";
import { CursorSdkRemoteError, cursorSdkWireError } from "./CursorSdkErrors.ts";
import { CursorSdkTransport, type CursorSdkWorkerMessage } from "./CursorSdkTransport.ts";
import { isCursorSdkError } from "./sdk.ts";

function deadline<A>(promise: Promise<A>, milliseconds: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Cursor SDK worker shutdown timed out.")),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function processError(cause: unknown, method: string): CursorAgentSdkRunnerError {
  return new CursorAgentSdkRunnerError({
    method: cause instanceof CursorSdkRemoteError ? (cause.method ?? method) : method,
    cause:
      cause instanceof CursorSdkRemoteError && cause.method !== undefined
        ? (cause.cause ?? cause)
        : cause,
  });
}

interface PendingRun {
  readonly scope: CursorSdkCallbackScope;
  readonly controller: AbortController;
  readonly delta: (update: InteractionUpdate) => Promise<void>;
  readonly resolve: (result: RunResult) => void;
  readonly reject: (error: unknown) => void;
}

export const makeCursorSdkProcessRunner = Effect.fn("makeCursorSdkProcessRunner")(function* (
  protocolLoggerFor: (input: CursorAgentSdkOpenInput) => CursorAgentSdkProtocolLogger | undefined,
) {
  const executablePath = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const hostEnvironment = yield* HostProcess.Environment;
  const sessions = new Set<() => Promise<void>>();
  const agentLeases = new Map<string, object>();
  const creationLeases = new Map<string, object>();
  const fromSource = import.meta.url.endsWith(".ts");
  const workerArguments = isExecutable
    ? ["__cursor-sdk-worker"]
    : [
        ...(fromSource ? ["--experimental-strip-types"] : []),
        NodeURL.fileURLToPath(
          new URL(
            fromSource
              ? "../../../../apps/server/src/cursor-sdk-worker.ts"
              : "./cursor-sdk-worker.mjs",
            import.meta.url,
          ),
        ),
      ];

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await Promise.allSettled([...sessions].map((close) => close()));
    }),
  );

  return CursorAgentSdkRunner.of({
    open: Effect.fn("CursorSdkProcess.open")(function* (input) {
      const context = yield* Effect.context<never>();
      const runEffect = async <A, E>(
        effect: Effect.Effect<A, E>,
        signal?: AbortSignal,
      ): Promise<A> => {
        const exit = await Effect.runPromiseExitWith(context)(
          effect,
          signal === undefined ? undefined : { signal },
        );
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      };
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const callbacks = new CursorSdkCallbacks();
          const sessionScope = callbacks.scope();
          const sessionController = new AbortController();
          const options = sessionScope.agentOptions(input.options);
          const log = protocolLoggerFor(input);
          const lease = {};
          const ownedLeases: Array<readonly [Map<string, object>, string]> = [];
          const releaseLeases = () => {
            for (const [leases, key] of ownedLeases) {
              if (leases.get(key) === lease) leases.delete(key);
            }
          };
          const reserve = (leases: Map<string, object>, key: string) => {
            if (leases.has(key) && leases.get(key) !== lease) {
              throw Object.assign(
                new Error("Cursor agent is already open in another SDK session."),
                { code: "CURSOR_AGENT_ALREADY_OPEN" },
              );
            }
            leases.set(key, lease);
            ownedLeases.push([leases, key]);
          };
          try {
            if (input.agentId !== undefined) reserve(agentLeases, input.agentId);
            if (input.options.agentId !== undefined) reserve(agentLeases, input.options.agentId);
            if (input.operation === "create" && input.options.idempotencyKey !== undefined)
              reserve(creationLeases, input.options.idempotencyKey);
          } catch (error) {
            releaseLeases();
            throw error;
          }
          // The OS environment is final before the worker can import or initialize the SDK.
          let child: ReturnType<typeof NodeChildProcess.spawn>;
          try {
            child = NodeChildProcess.spawn(executablePath, workerArguments, {
              env: {
                ...(input.environment ?? hostEnvironment),
                ELECTRON_RUN_AS_NODE: "1",
                T3CODE_THREAD_ID: input.threadId,
              },
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              serialization: "advanced",
              windowsHide: true,
            });
          } catch (error) {
            releaseLeases();
            throw error;
          }
          const runs = new Map<number, PendingRun>();
          let nextSendId = 0;
          let closed = false;
          let exited = false;
          let mayCloseAgent = true;
          let closePromise: Promise<void> | undefined;
          let stopPromise: Promise<void> | undefined;
          const exit = new Promise<void>((resolve) => {
            child.once("exit", () => {
              exited = true;
              releaseLeases();
              resolve();
            });
            child.once("error", () => {
              if (child.pid === undefined) {
                exited = true;
                releaseLeases();
                resolve();
              }
            });
          });
          const stop = () =>
            (stopPromise ??= (async () => {
              if (exited) return;
              child.kill("SIGTERM");
              try {
                await deadline(exit, 2_000);
              } catch {
                if (!exited) child.kill("SIGKILL");
                await deadline(exit, 2_000);
              }
            })());
          const failRuns = (error: unknown) => {
            sessionController.abort();
            for (const run of runs.values()) {
              run.controller.abort();
              run.scope.close();
              run.reject(error);
            }
            runs.clear();
            sessionScope.close();
          };
          const transport = new CursorSdkTransport(
            {
              send: (message, callback) => {
                child.send(message, (error) => callback(error ?? null));
              },
              onMessage: (listener) => {
                const receive = (message: unknown) => listener(message as CursorSdkWorkerMessage);
                child.on("message", receive);
                return () => {
                  child.off("message", receive);
                };
              },
              onDisconnect: (listener) => {
                child.on("disconnect", listener);
                return () => {
                  child.off("disconnect", listener);
                };
              },
            },
            async (message) => {
              switch (message.type) {
                case "callback": {
                  const callbackSignal =
                    message.sendId === undefined
                      ? sessionController.signal
                      : runs.get(message.sendId)?.controller.signal;
                  if (callbackSignal === undefined)
                    throw new Error("Cursor SDK callback belongs to a closed run.");
                  return callbacks.invoke(message.key, message.input, callbackSignal);
                }
                case "delta": {
                  const run = runs.get(message.sendId);
                  if (run === undefined)
                    throw new Error("Cursor SDK delta belongs to a closed run.");
                  return run.delta(message.update);
                }
                case "log":
                  if (log !== undefined)
                    await runEffect(log(message.event), sessionController.signal);
                  return;
                case "completed":
                case "runFailed": {
                  const run = runs.get(message.sendId);
                  if (run === undefined) return;
                  runs.delete(message.sendId);
                  run.scope.close();
                  if (message.type === "runFailed")
                    run.reject(new CursorSdkRemoteError(message.error));
                  else
                    run.resolve({
                      ...message.result,
                      ...(message.error === undefined
                        ? {}
                        : { error: new CursorSdkRemoteError(message.error) }),
                    } as RunResult);
                  return;
                }
                case "request":
                  throw new Error("Unexpected Cursor SDK worker request.");
              }
            },
            (error) => {
              failRuns(error);
              if (!closed) {
                closed = true;
                if (child.connected) child.disconnect();
                void deadline(exit, 2_500)
                  .catch(stop)
                  .catch(() => undefined)
                  .finally(() => sessions.delete(close));
              }
            },
            (error) => cursorSdkWireError(error, isCursorSdkError),
          );
          child.once("error", (error) => transport.fail(error));
          child.once("exit", (code, signal) =>
            transport.fail(new Error(`Cursor SDK worker exited (${code ?? signal ?? "unknown"}).`)),
          );
          const close = () =>
            (closePromise ??= (async () => {
              closed = true;
              try {
                if (!exited && mayCloseAgent)
                  await deadline(transport.request("close", undefined), 5_000);
              } finally {
                failRuns(new Error("Cursor SDK session closed."));
                try {
                  if (!exited) await deadline(exit, 2_000);
                } catch {
                  await stop();
                }
                transport.fail(new Error("Cursor SDK session closed."));
                sessions.delete(close);
              }
            })());
          sessions.add(close);
          const onOpenAbort = () => {
            void close().catch(() => undefined);
          };
          signal.addEventListener("abort", onOpenAbort, { once: true });
          try {
            const opened = await transport.request("open", {
              operation: input.operation,
              ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              options,
            });
            try {
              reserve(agentLeases, opened.agentId);
            } catch (error) {
              // A collided create has no run here; never close or cancel the leased native agent.
              mayCloseAgent = false;
              closed = true;
              child.kill("SIGKILL");
              throw error;
            }
            return {
              agentId: opened.agentId,
              send: Effect.fn("CursorSdkProcess.send")(function* (sendInput) {
                const sendContext = yield* Effect.context<never>();
                return yield* Effect.tryPromise({
                  try: async (sendSignal) => {
                    if (closed) throw new Error("Cursor SDK session is closed.");
                    const sendId = ++nextSendId;
                    const scope = callbacks.scope();
                    const controller = new AbortController();
                    const options =
                      sendInput.options === undefined
                        ? undefined
                        : scope.sendOptions(sendInput.options);
                    const completion = new Promise<RunResult>((resolve, reject) => {
                      runs.set(sendId, {
                        scope,
                        controller,
                        resolve,
                        reject,
                        delta: async (update) => {
                          if (sendInput.onDelta === undefined) return;
                          const result = await Effect.runPromiseExitWith(sendContext)(
                            sendInput.onDelta(update),
                            { signal: controller.signal },
                          );
                          if (Exit.isFailure(result)) throw Cause.squash(result.cause);
                        },
                      });
                    });
                    // A completion can fail before the caller obtains its run handle.
                    void completion.catch(() => undefined);
                    const cancel = async () => {
                      controller.abort();
                      await transport.request("cancel", { sendId });
                    };
                    const onSendAbort = () => {
                      void cancel().catch(() => undefined);
                    };
                    sendSignal.addEventListener("abort", onSendAbort, { once: true });
                    try {
                      const started = await transport.request("send", {
                        sendId,
                        message: sendInput.message,
                        ...(options === undefined ? {} : { options }),
                      });
                      return {
                        ...started,
                        wait: Effect.tryPromise({
                          try: () => completion,
                          catch: (cause) => processError(cause, "run.wait"),
                        }),
                        cancel: Effect.tryPromise({
                          try: cancel,
                          catch: (cause) => processError(cause, "run.cancel"),
                        }),
                      };
                    } catch (error) {
                      runs.get(sendId)?.reject(error);
                      runs.delete(sendId);
                      scope.close();
                      throw error;
                    } finally {
                      sendSignal.removeEventListener("abort", onSendAbort);
                    }
                  },
                  catch: (cause) => processError(cause, "run.start"),
                });
              }),
              listMessages: Effect.tryPromise({
                try: () => transport.request("messages", undefined),
                catch: (cause) => processError(cause, "agent.messages.list"),
              }),
              close: Effect.tryPromise({
                try: close,
                catch: (cause) => processError(cause, "agent.close"),
              }),
            } satisfies CursorAgentSdkSession;
          } catch (error) {
            await close().catch(() => undefined);
            throw error;
          } finally {
            signal.removeEventListener("abort", onOpenAbort);
          }
        },
        catch: (cause) => processError(cause, `agent.${input.operation}`),
      });
    }),
    assertComplete: Effect.void,
  });
});
