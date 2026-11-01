import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CuaControl from "./CuaControl.ts";

/** Acquire once in the provider session's scope, not in a transport handler. */
export const make = Effect.fn("CodexCuaSession.make")(function* (input: {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}) {
  const control = yield* CuaControl.CuaControl;
  const status = yield* control.status;
  const caller: CuaControl.CuaCaller = {
    ...input,
    environmentId: status.environmentId,
    driverKind: "codex",
  };
  const release = control.release(caller);
  yield* Effect.addFinalizer(() =>
    release.pipe(
      Effect.catch((cause) => Effect.logError("Computer-use session cleanup failed", cause)),
    ),
  );
  return {
    // Busy computer control must not prevent another ordinary coding session.
    connection: control.attach(caller).pipe(
      Effect.catchTags({
        CuaUnavailableError: (error) => {
          if (["disabled", "unsupportedPlatform", "busy"].includes(error.reason))
            return Effect.void;
          if (["stopped", "unreachableTarget", "incompatibleDriver"].includes(error.reason))
            return Effect.logWarning("Computer-use attachment unavailable", {
              reason: error.reason,
            });
          return Effect.fail(error);
        },
      }),
    ),
    release,
  };
});
