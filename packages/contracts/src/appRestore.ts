import * as Schema from "effect/Schema";

export const AppRestoreComponent = Schema.Literals(["desktop", "server"]);
export type AppRestoreComponent = typeof AppRestoreComponent.Type;

export const AppRestoreCandidate = Schema.Struct({
  version: Schema.String,
  sourceSha: Schema.NullOr(Schema.String),
  sha256: Schema.String,
  sizeBytes: Schema.Number,
  blockedReason: Schema.NullOr(Schema.String),
});
export type AppRestoreCandidate = typeof AppRestoreCandidate.Type;

export const AppRestoreState = Schema.Struct({
  component: AppRestoreComponent,
  installationId: Schema.String,
  currentVersion: Schema.String,
  updateHold: Schema.Boolean,
  maxVersions: Schema.Number,
  maxBytes: Schema.Number,
  totalBytes: Schema.Number,
  unavailableReason: Schema.NullOr(Schema.String),
  candidates: Schema.Array(AppRestoreCandidate),
});
export type AppRestoreState = typeof AppRestoreState.Type;

export const AppRestoreInput = Schema.Struct({
  version: Schema.String,
  expectedCurrentVersion: Schema.String,
  expectedHash: Schema.String,
});
export type AppRestoreInput = typeof AppRestoreInput.Type;

export const AppRestoreResult = Schema.Struct({
  status: Schema.Literals(["restored", "scheduled", "failed"]),
  version: Schema.String,
  reason: Schema.NullOr(Schema.String),
});
export type AppRestoreResult = typeof AppRestoreResult.Type;
