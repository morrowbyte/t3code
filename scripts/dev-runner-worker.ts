// @effect-diagnostics nodeBuiltinImport:off -- Private task-owned dev-runner controller.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";

import { DevRunnerWorkerInput, resolveTaskWorkspace, runDevRunnerWithInput } from "./dev-runner.ts";

const decodeInput = Schema.decodeUnknownEffect(DevRunnerWorkerInput);

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
  const directory = NodePath.join(workspace, ".t3", "dev-runner-output");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const logPath = yield* fs.makeTempFileScoped({ directory, prefix: "runner-", suffix: ".log" });
  let written = 0;
  const output = (chunk: Uint8Array) => {
    const remaining = 2 * 1024 * 1024 - written;
    if (remaining <= 0) return;
    const bytes = chunk.subarray(0, remaining);
    NodeFS.appendFileSync(logPath, bytes, { mode: 0o600 });
    written += bytes.length;
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
  Effect.tapCause((cause) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          if (!process.connected) return resolve();
          process.send?.({ error: Cause.pretty(cause).slice(0, 4096) }, () => resolve());
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
