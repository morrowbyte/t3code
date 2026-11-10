import type { AppRestoreInput, AppRestoreResult, AppRestoreState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { restoreStoppedServer } from "../serviceLauncher.ts";
import { acquireServiceLauncherLock, requestServerRestoreControl } from "./serverRestoreControl.ts";
import { serverUpdateHold, writeServerUpdateHold } from "./serverRestoreManifest.ts";
import { inspectServerRestore, readServerRestoreState } from "./serverRestoreStore.ts";

export class ServerRestoreError extends Schema.TaggedError<ServerRestoreError>()(
  "ServerRestoreError",
  {
    operation: Schema.Literals(["list", "restore", "release-hold"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server restore could not complete ${this.operation}. The installation remains protected; inspect the managed transaction before retrying.`;
  }
}

export const listServerRestore = Effect.fn("ServerRestore.list")(function* (input: {
  readonly baseDir: string;
}) {
  return yield* Effect.tryPromise({
    try: () => inspectServerRestore(input.baseDir),
    catch: (cause) => new ServerRestoreError({ operation: "list", cause }),
  });
});

export const restoreServerVersion = Effect.fn("ServerRestore.restore")(function* (
  input: AppRestoreInput & { readonly baseDir: string },
) {
  return yield* Effect.tryPromise({
    try: async () =>
      (await requestServerRestoreControl(input.baseDir, { action: "restore", input })) ??
      (await restoreStoppedServer(input.baseDir, input)),
    catch: (cause) => new ServerRestoreError({ operation: "restore", cause }),
  });
});

export const releaseServerUpdateHold = Effect.fn("ServerRestore.releaseHold")(function* (input: {
  readonly baseDir: string;
}) {
  return yield* Effect.tryPromise({
    try: async () => {
      const reply = await requestServerRestoreControl(input.baseDir, { action: "release-hold" });
      if (reply !== undefined) {
        if (reply.status === "failed")
          throw new Error("The launcher refused to release the update hold.");
        return await inspectServerRestore(input.baseDir);
      }
      const release = await acquireServiceLauncherLock(input.baseDir);
      try {
        const { state } = await readServerRestoreState(input.baseDir);
        if (state.update?.status === "pending")
          throw new Error("A version transaction is still pending.");
        await writeServerUpdateHold(input.baseDir, false);
        return await inspectServerRestore(input.baseDir);
      } finally {
        release();
      }
    },
    catch: (cause) => new ServerRestoreError({ operation: "release-hold", cause }),
  });
});

export const serverUpdatesOnHold = Effect.fn("ServerRestore.updateHold")(function* (input: {
  readonly baseDir: string;
}) {
  return yield* Effect.promise(() => serverUpdateHold(input.baseDir));
});

export class ServerRestore extends Context.Service<
  ServerRestore,
  {
    readonly list: (input: {
      readonly baseDir: string;
    }) => Effect.Effect<AppRestoreState, ServerRestoreError>;
    readonly restore: (
      input: AppRestoreInput & { readonly baseDir: string },
    ) => Effect.Effect<AppRestoreResult, ServerRestoreError>;
    readonly releaseHold: (input: {
      readonly baseDir: string;
    }) => Effect.Effect<AppRestoreState, ServerRestoreError>;
  }
>()("t3/cloud/ServerRestore") {}

export const layer = Layer.succeed(ServerRestore, {
  list: listServerRestore,
  restore: restoreServerVersion,
  releaseHold: releaseServerUpdateHold,
});
