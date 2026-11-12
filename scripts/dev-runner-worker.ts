// @effect-diagnostics nodeBuiltinImport:off -- Private task-owned dev-runner controller.
import * as NodeFS from "node:fs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { createDevRunnerOutput } from "@t3tools/shared/node/devRunnerControl";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";

import { DevRunnerWorkerInput, resolveTaskWorkspace, runDevRunnerWithInput } from "./dev-runner.ts";

const decodeInput = Schema.decodeUnknownEffect(DevRunnerWorkerInput);

let failureOutputPath: string | undefined;

const program = Effect.gen(function* () {
  const raw = yield* Effect.callback<unknown, Error>((resume) => {
    const message = (value: unknown) => resume(Effect.succeed(value));
    const disconnected = () =>
      resume(Effect.fail(new Error("Caller disconnected before task input")));
    process.once("message", message);
    process.once("disconnect", disconnected);
    if (process.connected) process.send?.({ type: "input" }, () => {});
    else disconnected();
    return Effect.sync(() => {
      process.off("message", message);
      process.off("disconnect", disconnected);
    });
  });
  const input = yield* decodeInput(raw);
  const workspace = yield* resolveTaskWorkspace(process.cwd());
  if (!workspace || !process.env.T3CODE_THREAD_ID)
    return yield* Effect.fail(new Error("Missing task owner"));
  const fs = yield* FileSystem.FileSystem;
  let retained = false;
  const log = yield* Effect.acquireRelease(
    createDevRunnerOutput({ workspacePath: workspace, threadId: process.env.T3CODE_THREAD_ID }),
    (log) => (retained ? Effect.void : log.remove),
  );
  const logPath = log.path;
  yield* fs.chmod(logPath, 0o600);
  let written = 0;
  let stderrTail = new Uint8Array(0);
  const output = (chunk: Uint8Array, channel?: "stdout" | "stderr") => {
    if (channel === "stderr") {
      const bytes = chunk.subarray(Math.max(0, chunk.length - 64 * 1024));
      const keep = Math.min(stderrTail.length, 64 * 1024 - bytes.length);
      const tail = new Uint8Array(keep + bytes.length);
      tail.set(stderrTail.subarray(stderrTail.length - keep));
      tail.set(bytes, keep);
      stderrTail = tail;
    }
    const limit = 2 * 1024 * 1024;
    if (chunk.length >= limit) {
      NodeFS.writeFileSync(logPath, chunk.subarray(chunk.length - limit), { mode: 0o600 });
      written = limit;
      return;
    }
    if (written + chunk.length > limit) {
      const keep = Math.min(written, 1024 * 1024, limit - chunk.length);
      const tail = new Uint8Array(keep);
      const fd = NodeFS.openSync(logPath, "r");
      try {
        NodeFS.readSync(fd, tail, 0, keep, written - keep);
      } finally {
        NodeFS.closeSync(fd);
      }
      NodeFS.writeFileSync(logPath, tail, { mode: 0o600 });
      written = keep;
    }
    NodeFS.appendFileSync(logPath, chunk, { mode: 0o600 });
    written += chunk.length;
  };
  yield* runDevRunnerWithInput(
    input,
    (connection, reused) => {
      output(new TextEncoder().encode(`[dev-runner] output capped at 2 MiB: ${logPath}\n`));
      if (process.connected)
        process.send?.(
          { connection, reused, outputPath: connection.outputPath ?? logPath },
          () => {},
        );
    },
    output,
    logPath,
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.sync(() => {
        if (stderrTail.length > 0) {
          output(new TextEncoder().encode("\n[dev-runner] stderr tail (up to 64 KiB):\n"));
          output(stderrTail);
        }
        output(new TextEncoder().encode(`\n[dev-runner] ${Cause.pretty(cause).slice(0, 4096)}\n`));
        retained = true;
        failureOutputPath = logPath;
      }).pipe(Effect.andThen(log.fail)),
    ),
    Effect.provide(
      Logger.layer([
        Logger.make((options) => {
          output(new TextEncoder().encode(`${String(options.message)}\n`));
        }),
      ]),
    ),
  );
});

program.pipe(
  Effect.scoped,
  Effect.tapCause(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          if (!process.connected) return resolve();
          process.send?.(
            {
              error: "Task controller failed; retain any unresolved runner receipt.",
              ...(failureOutputPath === undefined ? {} : { outputPath: failureOutputPath }),
            },
            () => resolve(),
          );
        }),
    ),
  ),
  Effect.ensuring(
    Effect.sync(() => {
      if (process.connected) process.disconnect();
    }),
  ),
  Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  NodeRuntime.runMain,
);
