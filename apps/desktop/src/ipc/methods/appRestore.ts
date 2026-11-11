import { AppRestoreInput, AppRestoreResult, AppRestoreState } from "@t3tools/contracts";
import {
  listDesktopRestores,
  releaseDesktopUpdateHold,
  restoreDesktopVersion,
} from "@t3tools/shared/desktopRestore";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export class DesktopRestoreIpcError extends Schema.TaggedError<DesktopRestoreIpcError>()(
  "DesktopRestoreIpcError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not ${this.operation} this Crew installation.`;
  }
}

export const listAppRestores = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESTORE_LIST_CHANNEL,
  payload: Schema.Void,
  result: AppRestoreState,
  handler: Effect.fn("desktop.ipc.restore.list")(function* () {
    const { baseDir } = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.tryPromise({
      try: () => listDesktopRestores({ baseDir }),
      catch: (cause) =>
        new DesktopRestoreIpcError({ operation: "read retained versions for", cause }),
    });
  }),
});

export const restoreAppVersion = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESTORE_VERSION_CHANNEL,
  payload: AppRestoreInput,
  result: AppRestoreResult,
  handler: Effect.fn("desktop.ipc.restore.version")(function* (input) {
    const { baseDir } = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.tryPromise({
      try: () => restoreDesktopVersion({ baseDir, ...input }),
      catch: (cause) => new DesktopRestoreIpcError({ operation: "restore", cause }),
    });
  }),
});

export const resumeAppUpdates = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESTORE_RESUME_UPDATES_CHANNEL,
  payload: Schema.Void,
  result: AppRestoreState,
  handler: Effect.fn("desktop.ipc.restore.resumeUpdates")(function* () {
    const { baseDir } = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.tryPromise({
      try: () => releaseDesktopUpdateHold({ baseDir }),
      catch: (cause) => new DesktopRestoreIpcError({ operation: "resume updates for", cause }),
    });
  }),
});
