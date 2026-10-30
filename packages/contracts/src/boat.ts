import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const BoatSize = Schema.Literals(["small", "default", "large", "xlarge"]);
export const BoatDefaults = Schema.Struct({
  ttlMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
  retentionDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 14 })),
});
export type BoatDefaults = typeof BoatDefaults.Type;
export const DEFAULT_BOAT_DEFAULTS: BoatDefaults = { ttlMinutes: 60, retentionDays: 14 };
export const BoatProjectConfig = Schema.Struct({
  enabled: Schema.Boolean,
  previewKind: Schema.Literals(["web", "android"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("web" as const)),
  ),
  size: BoatSize,
  ttlMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
  inheritDefaults: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  retentionDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 14 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(14)),
  ),
  maxConcurrent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  budgetUsd: Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 10000 })),
  snapshot: Schema.String.check(Schema.isMaxLength(200)),
  setupCommand: Schema.String.check(Schema.isMaxLength(8000)),
  devCommand: Schema.String.check(Schema.isMaxLength(8000)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  ciEnabled: Schema.Boolean,
  ciCommand: Schema.String.check(Schema.isMaxLength(8000)),
  releaseCommand: Schema.String.check(Schema.isMaxLength(8000)),
});
export type BoatProjectConfig = typeof BoatProjectConfig.Type;

export const DEFAULT_BOAT_PROJECT: BoatProjectConfig = {
  enabled: false,
  previewKind: "web",
  size: "default",
  ttlMinutes: 60,
  inheritDefaults: true,
  retentionDays: 14,
  maxConcurrent: 2,
  budgetUsd: 20,
  snapshot: "",
  setupCommand: "",
  devCommand: "",
  port: 3000,
  ciEnabled: false,
  ciCommand: "npm test",
  releaseCommand: "",
};

export const SavedSnapshot = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["saving", "ready", "failed"]),
});

export const BoatInstance = Schema.Struct({
  savedSnapshot: Schema.NullOr(SavedSnapshot).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  leases: Schema.Array(ThreadId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  stoppedAt: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  requestId: Schema.String,
  projectId: ProjectId,
  sandboxId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  previewTabId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  size: BoatSize,
  state: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  costUsd: Schema.Number,
  snapshot: Schema.String,
  processId: Schema.NullOr(Schema.Number),
  deletionOperationId: Schema.NullOr(Schema.String),
  output: Schema.String,
  previewUrl: Schema.NullOr(Schema.String),
});
export type BoatInstance = typeof BoatInstance.Type;

export const BoatState = Schema.Struct({
  defaults: BoatDefaults,
  configured: Schema.Boolean,
  account: Schema.NullOr(
    Schema.Struct({
      status: Schema.String,
      canStart: Schema.Boolean,
      reason: Schema.NullOr(Schema.String),
      remainingHours: Schema.Number,
      walletUsd: Schema.Number,
      maxConcurrent: Schema.Number,
      sizes: Schema.Array(BoatSize),
    }),
  ),
  projects: Schema.Record(ProjectId, BoatProjectConfig),
  instances: Schema.Array(BoatInstance),
});
export type BoatState = typeof BoatState.Type;

export const BoatReadInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export const BoatConnectInput = Schema.Struct({ apiKey: Schema.Redacted(Schema.String) });
export const BoatProjectInput = Schema.Struct({ projectId: ProjectId, config: BoatProjectConfig });
const instanceFields = {
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
};
export const BoatAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("exec"),
    ...instanceFields,
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  }),
  Schema.Struct({ action: Schema.Literal("start"), ...instanceFields }),
  Schema.Struct({
    action: Schema.Literals([
      "stop",
      "resume",
      "renew",
      "delete",
      "preview",
      "prepare",
      "logs",
      "cancel",
      "snapshot",
    ]),
    ...instanceFields,
  }),
]);
export type BoatAction = typeof BoatAction.Type;

export class BoatError extends Schema.TaggedError<BoatError>()("BoatError", {
  category: Schema.Literals([
    "not_configured",
    "disabled",
    "budget",
    "capacity",
    "not_found",
    "provider",
    "storage",
    "invalid_key",
    "conflict",
  ]),
  status: Schema.optional(Schema.Number),
}) {
  override get message() {
    switch (this.category) {
      case "not_configured":
        return "Connect a Boat account in Settings first.";
      case "disabled":
        return "Enable Boat for this project first.";
      case "budget":
        return "This project's Boat budget is exhausted.";
      case "capacity":
        return "The account or project has no available Boat capacity.";
      case "not_found":
        return "This Boat environment was not found in the project.";
      case "invalid_key":
        return "Boat did not accept this API key.";
      case "conflict":
        return "Reconcile the pending Boat operation before starting another.";
      case "storage":
        return "The Boat state could not be saved or read.";
      case "provider":
        return `Boat could not complete the request${this.status ? ` (HTTP ${this.status})` : ""}.`;
    }
  }
}
