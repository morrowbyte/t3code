import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HostUpdateStatus = Schema.Literals([
  "downloading",
  "ready",
  "installing",
  "awaiting-restart",
  "succeeded",
  "failed",
  "interrupted",
  "rolled-back",
]);
export type HostUpdateStatus = typeof HostUpdateStatus.Type;

export const HostUpdateRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  component: Schema.Literals(["server", "desktop"]),
  fromVersion: Schema.NullOr(Schema.String),
  targetVersion: Schema.NullOr(Schema.String),
  observedVersion: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  status: HostUpdateStatus,
  error: Schema.NullOr(Schema.String),
  receiptId: Schema.optionalKey(Schema.String),
});
export type HostUpdateRecord = typeof HostUpdateRecord.Type;

export const HostUpdateHistory = Schema.Struct({
  entries: Schema.Array(HostUpdateRecord),
  desktop: Schema.Literals(["available", "unavailable", "not-applicable"]),
  desktopError: Schema.optionalKey(Schema.String),
});
export type HostUpdateHistory = typeof HostUpdateHistory.Type;

export const DeleteHostUpdateInput = Schema.Struct({
  component: Schema.Literals(["server", "desktop"]),
  id: TrimmedNonEmptyString,
});

export class HostUpdateHistoryError extends Schema.TaggedError<HostUpdateHistoryError>()(
  "HostUpdateHistoryError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export function isHostUpdateTerminal(status: HostUpdateStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "rolled-back"
  );
}
