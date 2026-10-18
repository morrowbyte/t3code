// @effect-diagnostics nodeBuiltinImport:off - PKCE and stable delivery digests use Node's cryptography.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  LinearAction,
  LinearBinding,
  LinearDelivery,
  LinearIntegrationError,
  LinearSettings,
  LinearWorkspace,
  MessageId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import {
  constantTimeEquals,
  verifyWebhookSignature,
} from "../../scheduledTasks/webhookVerification.ts";
import * as LinearApi from "./LinearApi.ts";

export class LinearOAuthConfig extends Context.Reference<{
  readonly clientId: string;
  readonly redirectUri: string;
}>("t3/integrations/LinearOAuthConfig", {
  defaultValue: () => ({
    clientId: process.env.T3CODE_LINEAR_CLIENT_ID?.trim() ?? "",
    redirectUri: process.env.T3CODE_LINEAR_REDIRECT_URI?.trim() ?? "",
  }),
}) {}

const StoredDelivery = Schema.Struct({
  ...LinearDelivery.fields,
  issueId: Schema.String,
  digest: Schema.String,
  providerDeliveryId: Schema.String,
  text: Schema.String,
});
type StoredDelivery = typeof StoredDelivery.Type;
const State = Schema.Struct({
  enabled: Schema.Boolean,
  connection: LinearSettings.fields.connection,
  workspace: Schema.NullOr(LinearWorkspace),
  bindings: Schema.Array(LinearBinding),
  deliveries: Schema.Array(StoredDelivery),
});
const PendingOAuth = Schema.Struct({
  state: Schema.String,
  verifier: Schema.String,
  expiresAt: Schema.Number,
});
const encodeState = Schema.encodeEffect(Schema.fromJsonString(State));
const encodePendingOAuth = Schema.encodeEffect(Schema.fromJsonString(PendingOAuth));
const decodePendingOAuth = Schema.decodeEffect(Schema.fromJsonString(PendingOAuth));
const Event = Schema.Struct({
  type: Schema.Literals(["Issue", "Comment"]),
  action: Schema.String,
  organizationId: Schema.String,
  webhookTimestamp: Schema.Number,
  actor: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
  data: Schema.Struct({
    id: Schema.String,
    issueId: Schema.optional(Schema.String),
    issue: Schema.optional(Schema.Struct({ id: Schema.String })),
    body: Schema.optional(Schema.String),
  }),
});
const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(Event));
const TOKEN = "linear-oauth-token";
const PENDING = "linear-oauth-pending";
const WEBHOOK_SECRET = "linear-webhook-secret";
const TTL = 24 * 60 * 60 * 1000;
const storageError = () => new LinearIntegrationError({ reason: "storage" });
const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

export class LinearIntegration extends Context.Service<
  LinearIntegration,
  {
    readonly settings: Effect.Effect<LinearSettings, LinearIntegrationError>;
    readonly action: (
      input: LinearAction,
    ) => Effect.Effect<
      { readonly settings: LinearSettings; readonly authorizeUrl?: string },
      LinearIntegrationError
    >;
    readonly callback: (input: {
      readonly state: string;
      readonly code: string;
    }) => Effect.Effect<void, LinearIntegrationError>;
    readonly receive: (input: {
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    }) => Effect.Effect<
      "accepted" | "duplicate" | "disabled" | "rejected" | "queue_full",
      LinearIntegrationError
    >;
    readonly drain: Effect.Effect<void, LinearIntegrationError>;
  }
>()("t3/integrations/linear/LinearIntegration") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const api = yield* LinearApi.LinearApi;
  const oauth = yield* LinearOAuthConfig;
  const lock = yield* Semaphore.make(1);
  const filename = path.join(config.stateDir, "linear-integration.json");
  const initial = {
    enabled: false,
    connection: "disconnected" as const,
    workspace: null,
    bindings: [],
    deliveries: [],
  };
  let state: typeof State.Type = (yield* fs.exists(filename))
    ? yield* fs
        .readFileString(filename)
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(State))),
          Effect.mapError(storageError),
        )
    : initial;
  const oauthConfigured =
    oauth.clientId !== "" &&
    URL.canParse(oauth.redirectUri) &&
    new URL(oauth.redirectUri).pathname === "/api/integrations/linear/oauth/callback";
  const save = Effect.fnUntraced(function* (next: typeof State.Type) {
    const encoded = yield* encodeState(next).pipe(Effect.mapError(storageError));
    yield* fs
      .writeFileString(`${filename}.tmp`, encoded, { mode: 0o600 })
      .pipe(Effect.andThen(fs.rename(`${filename}.tmp`, filename)), Effect.mapError(storageError));
    state = next;
  });
  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.mapError(storageError),
      Effect.map((value) => Option.map(value, (bytes) => new TextDecoder().decode(bytes))),
    );
  const writeSecret = (name: string, value: string) =>
    secrets.set(name, new TextEncoder().encode(value)).pipe(Effect.mapError(storageError));
  const removeSecret = (name: string) => secrets.remove(name).pipe(Effect.mapError(storageError));
  const settings = Effect.gen(function* () {
    const webhook = yield* readSecret(WEBHOOK_SECRET);
    return {
      ...state,
      environmentId,
      oauthConfigured,
      webhookConfigured: Option.isSome(webhook),
      deliveries: state.deliveries.map(
        ({
          issueId: _issue,
          digest: _digest,
          providerDeliveryId: _provider,
          text: _text,
          ...delivery
        }) => delivery,
      ),
    };
  });
  const updateDelivery = (id: string, update: Partial<LinearDelivery>) =>
    save({
      ...state,
      deliveries: state.deliveries.map((delivery) =>
        delivery.id === id ? { ...delivery, ...update } : delivery,
      ),
    });
  const connectedToken = Effect.gen(function* () {
    if (!state.enabled) return yield* new LinearIntegrationError({ reason: "disabled" });
    if (state.connection !== "connected" || state.workspace === null)
      return yield* new LinearIntegrationError({
        reason: state.connection === "revoked" ? "revoked" : "not_connected",
      });
    const token = yield* readSecret(TOKEN);
    if (Option.isNone(token)) return yield* new LinearIntegrationError({ reason: "not_connected" });
    return token.value;
  });
  const requestIssue = (issueId: string) =>
    connectedToken.pipe(
      Effect.flatMap((token) => api.issue(token, issueId)),
      Effect.tapError((error) =>
        error.reason === "revoked" ? save({ ...state, connection: "revoked" }) : Effect.void,
      ),
    );
  const boundThread = (binding: { readonly projectId: ProjectId; readonly threadId: ThreadId }) =>
    threads
      .getProjectThreadRecords(binding, ["runs", "providerThreads"])
      .pipe(Effect.mapError(() => new LinearIntegrationError({ reason: "target_unavailable" })));

  const deliver = Effect.fnUntraced(function* (delivery: StoredDelivery) {
    if (!state.enabled || state.connection !== "connected") return;
    const binding = state.bindings.find(
      (item) => item.id === delivery.bindingId && item.workspaceId === state.workspace?.id,
    );
    if (!binding) return yield* updateDelivery(delivery.id, { outcome: "unbound" });
    if ((yield* Clock.currentTimeMillis) - delivery.receivedAt > TTL)
      return yield* updateDelivery(delivery.id, { outcome: "expired" });
    const commandId = CommandId.make(`linear:${delivery.id}`);
    // A crash after dispatch but before our acknowledgement replays the normal command receipt.
    if (
      yield* threads
        .hasReceipt(commandId)
        .pipe(Effect.mapError(() => new LinearIntegrationError({ reason: "target_unavailable" })))
    )
      return yield* updateDelivery(delivery.id, { outcome: "delivered" });
    const target = yield* boundThread(binding);
    const latest = target.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    const owner = target.providerThreads.find((item) => item.id === latest?.providerThreadId);
    if (
      target.thread.archivedAt !== null ||
      target.thread.deletedAt !== null ||
      owner?.goal?.status === "paused" ||
      latest?.status === "interrupted" ||
      latest?.status === "cancelled"
    )
      return yield* updateDelivery(delivery.id, { outcome: "stopped" });
    // Steer rechecks the active run inside the normal send path. A concurrent Stop cannot turn this into a restart.
    if (!latest || !["running", "starting"].includes(latest.status))
      return yield* updateDelivery(delivery.id, { outcome: "idle" });
    const issue = yield* requestIssue(binding.issueId);
    if (issue.team.id !== binding.teamId || (issue.project?.id ?? null) !== binding.linearProjectId)
      return yield* updateDelivery(delivery.id, { outcome: "unbound" });
    // Reserve the accepted instruction before assigning the remaining budget to issue context.
    const instruction = delivery.text.slice(0, 8000);
    const header = `Linear ${issue.identifier}: ${issue.title}\n${issue.url}`.slice(0, 4000);
    const description = (issue.description ?? "").slice(
      0,
      24000 - header.length - instruction.length - 4,
    );
    const sent = yield* threads
      .sendToThread({
        projectId: binding.projectId,
        threadId: binding.threadId,
        commandId,
        messageId: MessageId.make(`linear-message:${delivery.id}`),
        text: `${header}\n\n${instruction}\n\n${description}`,
        attachments: [],
        mode: "steer",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(() => new LinearIntegrationError({ reason: "target_unavailable" })));
    yield* updateDelivery(delivery.id, {
      outcome: "delivered",
      runId: sent.run.id,
      dispatch: sent.delivery,
    });
  });
  const drainUnlocked = Effect.gen(function* () {
    if (!state.enabled || state.connection !== "connected") return;
    for (const delivery of state.deliveries.filter((item) => item.outcome === "pending")) {
      yield* deliver(delivery).pipe(
        Effect.catch((error) =>
          updateDelivery(delivery.id, {
            outcome:
              error.reason === "offline"
                ? "offline"
                : error.reason === "revoked"
                  ? "revoked"
                  : error.reason === "target_unavailable"
                    ? "stopped"
                    : "failed",
          }),
        ),
      );
    }
  });
  const drain = drainUnlocked.pipe(lock.withPermits(1), Effect.withTracerEnabled(false));
  const addDelivery = Effect.fnUntraced(function* (delivery: StoredDelivery) {
    const now = yield* Clock.currentTimeMillis;
    const retained = state.deliveries.filter((item) => now - item.receivedAt <= TTL);
    if (retained.length >= 100) return yield* new LinearIntegrationError({ reason: "invalid" });
    yield* save({ ...state, deliveries: [...retained, delivery] });
  });

  const action = (input: LinearAction) =>
    Effect.gen(function* () {
      let authorizeUrl: string | undefined;
      if (input.type === "enable") {
        yield* save({
          ...state,
          enabled: input.enabled,
          deliveries: input.enabled
            ? state.deliveries
            : state.deliveries.map((item) =>
                item.outcome === "pending" ? { ...item, outcome: "disabled" as const } : item,
              ),
        });
        if (!input.enabled) yield* removeSecret(PENDING);
      } else if (input.type === "disconnect") {
        yield* save({
          ...state,
          connection: "disconnected",
          workspace: null,
          bindings: [],
          deliveries: [],
        });
        yield* removeSecret(TOKEN);
        yield* removeSecret(PENDING);
        yield* removeSecret(WEBHOOK_SECRET);
      } else {
        if (!state.enabled) return yield* new LinearIntegrationError({ reason: "disabled" });
        if (input.type === "connect") {
          if (!oauthConfigured)
            return yield* new LinearIntegrationError({ reason: "oauth_unconfigured" });
          const nonce = NodeCrypto.randomBytes(32).toString("base64url");
          const verifier = NodeCrypto.randomBytes(32).toString("base64url");
          const pending = yield* encodePendingOAuth({
            state: nonce,
            verifier,
            expiresAt: (yield* Clock.currentTimeMillis) + 10 * 60 * 1000,
          }).pipe(Effect.mapError(storageError));
          yield* writeSecret(PENDING, pending);
          const url = new URL("https://linear.app/oauth/authorize");
          url.search = new URLSearchParams({
            client_id: oauth.clientId,
            redirect_uri: oauth.redirectUri,
            response_type: "code",
            scope: "read",
            actor: "app",
            state: nonce,
            code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
          }).toString();
          authorizeUrl = url.toString();
        } else if (input.type === "webhook-secret") {
          yield* connectedToken;
          yield* writeSecret(WEBHOOK_SECRET, input.secret);
        } else if (input.type === "bind") {
          if (state.bindings.length >= 10)
            return yield* new LinearIntegrationError({ reason: "invalid" });
          const issue = yield* requestIssue(input.issueId);
          const target = yield* boundThread(input);
          if (target.thread.archivedAt !== null || target.thread.deletedAt !== null)
            return yield* new LinearIntegrationError({ reason: "target_unavailable" });
          const binding: LinearBinding = {
            id: issue.id,
            workspaceId: state.workspace!.id,
            teamId: issue.team.id,
            linearProjectId: issue.project?.id ?? null,
            issueId: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            projectId: input.projectId,
            threadId: input.threadId,
          };
          yield* save({
            ...state,
            bindings: [...state.bindings.filter((item) => item.id !== binding.id), binding],
          });
        } else if (input.type === "unbind") {
          yield* save({
            ...state,
            bindings: state.bindings.filter((item) => item.id !== input.bindingId),
          });
        } else if (input.type === "sync") {
          const binding = state.bindings.find((item) => item.id === input.bindingId);
          if (!binding) return yield* new LinearIntegrationError({ reason: "invalid" });
          const issue = yield* requestIssue(binding.issueId);
          const id = digest(`${binding.workspaceId}:${binding.issueId}:${issue.updatedAt}`);
          if (!state.deliveries.some((item) => item.id === id))
            yield* addDelivery({
              id,
              bindingId: binding.id,
              issueId: issue.id,
              receivedAt: yield* Clock.currentTimeMillis,
              outcome: "pending",
              digest: id,
              providerDeliveryId: id,
              text: "Manually requested issue sync.",
              runId: null,
              dispatch: null,
            });
          yield* drainUnlocked;
        } else if (input.type === "retry") {
          const delivery = state.deliveries.find((item) => item.id === input.deliveryId);
          if (!delivery || delivery.outcome === "delivered" || delivery.outcome === "own_reply")
            return yield* new LinearIntegrationError({ reason: "invalid" });
          yield* connectedToken;
          yield* updateDelivery(delivery.id, { outcome: "pending" });
          yield* drainUnlocked;
        }
      }
      return { settings: yield* settings, ...(authorizeUrl ? { authorizeUrl } : {}) };
    }).pipe(lock.withPermits(1), Effect.withTracerEnabled(false));

  const callback = (input: { readonly code: string; readonly state: string }) =>
    Effect.gen(function* () {
      if (!state.enabled) return yield* new LinearIntegrationError({ reason: "disabled" });
      if (!oauthConfigured)
        return yield* new LinearIntegrationError({ reason: "oauth_unconfigured" });
      const stored = yield* readSecret(PENDING);
      if (Option.isNone(stored)) return yield* new LinearIntegrationError({ reason: "invalid" });
      const pending = yield* decodePendingOAuth(stored.value).pipe(
        Effect.mapError(() => new LinearIntegrationError({ reason: "invalid" })),
      );
      if (
        !constantTimeEquals(pending.state, input.state) ||
        pending.expiresAt < (yield* Clock.currentTimeMillis)
      )
        return yield* new LinearIntegrationError({ reason: "invalid" });
      yield* removeSecret(PENDING);
      const token = yield* api.token({ ...oauth, code: input.code, verifier: pending.verifier });
      const identity = yield* api.identity(token.access_token);
      yield* writeSecret(TOKEN, token.access_token);
      const sameWorkspace = state.workspace?.id === identity.organization.id;
      yield* save({
        ...state,
        connection: "connected",
        workspace: { ...identity.organization, actorId: identity.viewer.id },
        bindings: sameWorkspace ? state.bindings : [],
        deliveries: sameWorkspace ? state.deliveries : [],
      });
    }).pipe(lock.withPermits(1), Effect.withTracerEnabled(false));

  const receive: LinearIntegration["Service"]["receive"] = (input) =>
    Effect.gen(function* () {
      if (!state.enabled || state.connection !== "connected" || !state.workspace)
        return "disabled" as const;
      if (input.body.byteLength > 1024 * 1024) return "rejected" as const;
      const secret = yield* readSecret(WEBHOOK_SECRET);
      if (
        Option.isNone(secret) ||
        !verifyWebhookSignature({
          signature: { header: "linear-signature", encoding: "hex", prefix: "" },
          secret: secret.value,
          headers: input.headers,
          body: input.body,
        })
      )
        return "rejected" as const;
      const event = yield* decodeEvent(new TextDecoder().decode(input.body)).pipe(Effect.option);
      if (Option.isNone(event)) return "rejected" as const;
      const now = yield* Clock.currentTimeMillis;
      if (
        Math.abs(now - event.value.webhookTimestamp) > 60_000 ||
        event.value.organizationId !== state.workspace.id
      )
        return "rejected" as const;
      const hash = digest(input.body);
      const providerDeliveryId = input.headers["linear-delivery"]?.slice(0, 200) ?? hash;
      if (
        state.deliveries.some(
          (item) => item.digest === hash || item.providerDeliveryId === providerDeliveryId,
        )
      )
        return "duplicate" as const;
      if (
        state.deliveries.filter((item) => item.outcome === "pending").length >= 20 ||
        state.deliveries.filter((item) => now - item.receivedAt <= TTL).length >= 100
      )
        return "queue_full" as const;
      const issueId =
        event.value.type === "Issue"
          ? event.value.data.id
          : (event.value.data.issueId ?? event.value.data.issue?.id);
      const binding = state.bindings.find((item) => item.issueId === issueId);
      const ownReply = event.value.actor?.id === state.workspace.actorId;
      yield* addDelivery({
        id: digest(`${state.workspace.id}:${providerDeliveryId}`),
        bindingId: binding?.id ?? null,
        issueId: issueId ?? "",
        digest: hash,
        providerDeliveryId,
        receivedAt: now,
        outcome: ownReply ? "own_reply" : binding ? "pending" : "unbound",
        text:
          event.value.type === "Comment"
            ? (event.value.data.body ?? "").slice(0, 8000)
            : "Issue updated in Linear.",
        runId: null,
        dispatch: null,
      });
      return "accepted" as const;
    }).pipe(lock.withPermits(1), Effect.withTracerEnabled(false));
  yield* (yield* Scheduler.Scheduler).register("linear-deliveries", drain);
  return LinearIntegration.of({ settings, action, callback, receive, drain });
});
export const layer = Layer.effect(LinearIntegration, make);
