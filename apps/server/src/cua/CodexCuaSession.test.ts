import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CodexCuaSession from "./CodexCuaSession.ts";
import * as CuaControl from "./CuaControl.ts";

it.effect.each([
  { reason: "disabled" as const, optional: true },
  { reason: "unsupportedPlatform" as const, optional: true },
  { reason: "busy" as const, optional: true },
  { reason: "stopped" as const, optional: true },
  { reason: "unreachableTarget" as const, optional: true },
  { reason: "incompatibleDriver" as const, optional: true },
  { reason: "targetMismatch" as const, optional: false },
  { reason: "unsupportedProvider" as const, optional: false },
])("isolates optional CUA attachment failure $reason", ({ reason, optional }) =>
  Effect.gen(function* () {
    const session = yield* CodexCuaSession.make({
      threadId: ThreadId.make("thread-one"),
      providerSessionId: "session-one",
      providerInstanceId: ProviderInstanceId.make("codex-one"),
    });
    if (optional) expect(yield* session.connection).toBeUndefined();
    else expect(yield* Effect.flip(session.connection)).toMatchObject({ reason });
  }).pipe(
    Effect.provide(
      Layer.mock(CuaControl.CuaControl)({
        status: Effect.succeed({
          environmentId: EnvironmentId.make("cua-target"),
          supported: true,
          enabled: true,
          phase: "failed",
          owner: null,
        }),
        attach: () => Effect.fail(new CuaControl.CuaUnavailableError({ reason })),
        release: () => Effect.void,
      }),
    ),
    Effect.scoped,
  ),
);
