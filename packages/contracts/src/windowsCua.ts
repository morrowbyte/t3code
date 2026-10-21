import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

export const WindowsCuaStatus = Schema.Struct({
  environmentId: EnvironmentId,
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  phase: Schema.Literals(["disabled", "idle", "starting", "ready", "stopping", "failed"]),
  ownerThreadId: Schema.NullOr(ThreadId),
});
export type WindowsCuaStatus = typeof WindowsCuaStatus.Type;

export class WindowsCuaStatusError extends Schema.TaggedError<WindowsCuaStatusError>()(
  "WindowsCuaStatusError",
  {},
) {
  override get message() {
    return "Windows computer control is unavailable in this environment.";
  }
}
