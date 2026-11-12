// @effect-diagnostics globalTimers:off -- The worker has a finite parent-disconnect shutdown deadline.
import type { RunResult } from "@cursor/sdk";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  makeCursorAgentSdkRunner,
  type CursorAgentSdkRun,
  type CursorAgentSdkRunner,
  type CursorAgentSdkSession,
} from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import { cursorSdkWorkerOptions } from "./CursorSdkCallbacks.ts";
import { cursorSdkWireError } from "./CursorSdkErrors.ts";
import {
  CursorSdkTransport,
  type CursorSdkWorkerMessage,
  type CursorSdkWorkerRequest,
} from "./CursorSdkTransport.ts";
import { isCursorSdkError } from "./sdk.ts";

async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

const encodeError = (error: unknown) => cursorSdkWireError(error, isCursorSdkError);

export function makeCursorSdkWorkerSession(
  runner: CursorAgentSdkRunner["Service"],
  transport: Pick<CursorSdkTransport, "callback" | "delta" | "send">,
  owner: string,
) {
  let opened = false;
  let closing = false;
  let session: CursorAgentSdkSession | undefined;
  let opening: Promise<CursorAgentSdkSession> | undefined;
  let closePromise: Promise<void> | undefined;
  const runs = new Map<number, { cancelRequested: boolean; run?: CursorAgentSdkRun }>();
  const options = cursorSdkWorkerOptions((key, input) =>
    transport.callback(key, input, runs.keys().next().value),
  );
  const close = () =>
    (closePromise ??= (async () => {
      closing = true;
      for (const active of runs.values()) active.cancelRequested = true;
      const cancelling = Promise.allSettled(
        [...runs.values()].flatMap((active) =>
          active.run === undefined ? [] : [run(active.run.cancel)],
        ),
      );
      const current = session ?? (await opening?.catch(() => undefined));
      try {
        if (current !== undefined) await run(current.close);
      } finally {
        await cancelling;
        runs.clear();
      }
    })());
  const handle = async (request: CursorSdkWorkerRequest): Promise<unknown> => {
    if (request.method === "close") return close();
    if (closing) throw new Error("Cursor SDK worker session is closing.");
    if (request.method === "open") {
      if (opened || request.input.threadId !== owner)
        throw new Error("Cursor SDK worker cannot change its canonical owner or session.");
      opened = true;
      opening = run(
        runner.open({
          ...request.input,
          threadId: ThreadId.make(request.input.threadId),
          providerSessionId: ProviderSessionId.make(request.input.providerSessionId),
          options: options.agentOptions(request.input.options),
        }),
      );
      session = await opening;
      if (closing) {
        await close();
        throw new Error("Cursor SDK session closed while opening.");
      }
      return { agentId: session.agentId };
    }
    if (session === undefined) throw new Error("Cursor SDK worker session is not open.");
    switch (request.method) {
      case "messages":
        return run(session.listMessages);
      case "cancel": {
        const active = runs.get(request.input.sendId);
        if (active === undefined) return;
        active.cancelRequested = true;
        if (active.run !== undefined) await run(active.run.cancel);
        return;
      }
      case "send": {
        const { sendId } = request.input;
        if (runs.has(sendId)) throw new Error("Duplicate Cursor SDK send handle.");
        if (runs.size > 0) throw new Error(`Agent ${session.agentId} already has active run`);
        const active: { cancelRequested: boolean; run?: CursorAgentSdkRun } = {
          cancelRequested: false,
        };
        runs.set(sendId, active);
        try {
          const started = await run(
            session.send({
              message: request.input.message,
              ...(request.input.options === undefined
                ? {}
                : { options: options.sendOptions(request.input.options) }),
              onDelta: (update) => Effect.tryPromise(() => transport.delta(sendId, update)),
            }),
          );
          active.run = started;
          if (active.cancelRequested || closing) await run(started.cancel);
          // Start waiting once; completion also releases handles when the parent never awaits wait.
          void run(started.wait)
            .then(
              (result) => {
                runs.delete(sendId);
                const { error, ...rest } = result;
                return transport.send({
                  type: "completed",
                  sendId,
                  result: rest as Omit<RunResult, "error">,
                  ...(error === undefined ? {} : { error: encodeError(error) }),
                });
              },
              (error: unknown) => {
                runs.delete(sendId);
                return transport.send({ type: "runFailed", sendId, error: encodeError(error) });
              },
            )
            .catch(() => undefined)
            .finally(() => {
              runs.delete(sendId);
            });
          return { runId: started.runId, agentId: started.agentId };
        } catch (error) {
          runs.delete(sendId);
          throw error;
        }
      }
    }
  };
  return { handle, close };
}

export async function runCursorSdkWorker(): Promise<void> {
  if (process.send === undefined || process.env.T3CODE_THREAD_ID === undefined)
    throw new Error("Cursor SDK worker requires private IPC and a canonical owner.");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let finish!: () => void;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let closeRequest: number | undefined;
        let shutdown: ReturnType<typeof setTimeout> | undefined;
        const runner = yield* makeCursorAgentSdkRunner(
          () => (event) => Effect.promise(() => transport.log(event)),
        );
        const transport: CursorSdkTransport = new CursorSdkTransport(
          {
            send: (message, callback) => {
              process.send!(message, (error: Error | null) => {
                callback(error ?? null);
                if (
                  (message.type === "response" || message.type === "failure") &&
                  message.id === closeRequest
                )
                  finish();
              });
            },
            onMessage: (listener) => {
              const receive = (message: unknown) => listener(message as CursorSdkWorkerMessage);
              process.on("message", receive);
              return () => {
                process.off("message", receive);
              };
            },
            onDisconnect: (listener) => {
              process.on("disconnect", listener);
              return () => {
                process.off("disconnect", listener);
              };
            },
          },
          async (message) => {
            if (message.type !== "request")
              throw new Error("Unexpected Cursor SDK parent message.");
            if (message.method === "close") closeRequest = message.id;
            return worker.handle(message);
          },
          () => {
            shutdown ??= setTimeout(finish, 2_000);
            void worker
              .close()
              .catch(() => undefined)
              .finally(finish);
          },
          encodeError,
        );
        const worker = makeCursorSdkWorkerSession(runner, transport, process.env.T3CODE_THREAD_ID!);
        try {
          yield* Effect.promise(() => finished);
        } finally {
          clearTimeout(shutdown);
          transport.fail(new Error("Cursor SDK worker stopped."));
        }
      }).pipe(Effect.provide(CursorSdk.layer)),
    ),
  );
}
