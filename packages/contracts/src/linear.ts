import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LinearWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actorId: Schema.String,
});

export const LinearBinding = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  teamId: Schema.String,
  linearProjectId: Schema.NullOr(Schema.String),
  issueId: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type LinearBinding = typeof LinearBinding.Type;

export const LinearDeliveryOutcome = Schema.Literals([
  "pending",
  "delivered",
  "idle",
  "stopped",
  "offline",
  "revoked",
  "disabled",
  "own_reply",
  "unbound",
  "expired",
  "failed",
]);
export const LinearDelivery = Schema.Struct({
  id: Schema.String,
  bindingId: Schema.NullOr(Schema.String),
  receivedAt: Schema.Number,
  outcome: LinearDeliveryOutcome,
  runId: Schema.NullOr(Schema.String),
  dispatch: Schema.NullOr(Schema.Literals(["started", "queued", "steered", "restarted"])),
});
export type LinearDelivery = typeof LinearDelivery.Type;

export const LinearSettings = Schema.Struct({
  enabled: Schema.Boolean,
  environmentId: EnvironmentId,
  oauthConfigured: Schema.Boolean,
  webhookConfigured: Schema.Boolean,
  connection: Schema.Literals(["disconnected", "connected", "revoked"]),
  workspace: Schema.NullOr(LinearWorkspace),
  bindings: Schema.Array(LinearBinding),
  deliveries: Schema.Array(LinearDelivery),
});
export type LinearSettings = typeof LinearSettings.Type;

export const LinearAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("enable"), enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("connect") }),
  Schema.Struct({ type: Schema.Literal("disconnect") }),
  Schema.Struct({
    type: Schema.Literal("webhook-secret"),
    secret: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    type: Schema.Literal("bind"),
    issueId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    projectId: ProjectId,
    threadId: ThreadId,
  }),
  Schema.Struct({ type: Schema.Literal("unbind"), bindingId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("sync"), bindingId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("retry"), deliveryId: Schema.String }),
]);
export type LinearAction = typeof LinearAction.Type;
export const LinearActionResult = Schema.Struct({
  settings: LinearSettings,
  authorizeUrl: Schema.optional(Schema.String),
});

export class LinearIntegrationError extends Schema.TaggedError<LinearIntegrationError>()(
  "LinearIntegrationError",
  {
    reason: Schema.Literals([
      "disabled",
      "oauth_unconfigured",
      "not_connected",
      "revoked",
      "offline",
      "invalid",
      "storage",
      "target_unavailable",
    ]),
  },
) {
  override get message() {
    return `Linear integration: ${this.reason}.`;
  }
}
