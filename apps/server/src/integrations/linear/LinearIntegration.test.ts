// @effect-diagnostics nodeBuiltinImport:off - Synthetic provider HMAC signatures use Node's cryptography.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  LinearIntegrationError,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as LinearApi from "./LinearApi.ts";
import * as LinearIntegration from "./LinearIntegration.ts";

const projectId = ProjectId.make("linear-fixture-project");
const threadId = ThreadId.make("linear-existing-thread");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const oauth = {
  clientId: "fixture-public-client",
  redirectUri: "http://localhost:7677/api/integrations/linear/oauth/callback",
};

function fixture(configured = true) {
  const calls: string[] = [];
  const sends: Threads.ThreadManagementSendInput[] = [];
  const receipts = new Set<string>();
  const upstream = {
    reason: null as "offline" | "revoked" | null,
    updatedAt: "2026-10-19T00:00:00Z",
  };
  const target = {
    status: "running",
    paused: false,
    archived: false,
    deleted: false,
    failAfterCommit: false,
  };
  const issue = () => ({
    id: "issue-one",
    identifier: "WEA-14",
    title: "Synthetic issue",
    description: "Synthetic issue text",
    url: "https://linear.app/example/issue/WEA-14",
    updatedAt: upstream.updatedAt,
    team: { id: "team-one" },
    project: { id: "linear-project-one" },
  });
  const api = LinearApi.LinearApi.of({
    token: () =>
      Effect.sync(() => {
        calls.push("token");
        return { access_token: "fixture-private-token" };
      }),
    identity: () =>
      Effect.sync(() => {
        calls.push("identity");
        return {
          viewer: { id: "our-app-actor" },
          organization: { id: "workspace-one", name: "Fixture workspace" },
        };
      }),
    issue: () =>
      Effect.gen(function* () {
        calls.push("issue");
        if (upstream.reason) return yield* new LinearIntegrationError({ reason: upstream.reason });
        return issue();
      }),
  });
  const threads = {
    hasReceipt: (id: string) => Effect.succeed(receipts.has(id)),
    getProjectThreadRecords: (input: { projectId: string; threadId: string }) =>
      Effect.sync(() => {
        if (input.projectId !== projectId || input.threadId !== threadId)
          throw new Error("Wrong fixture target");
        return {
          thread: {
            projectId,
            id: threadId,
            archivedAt: target.archived ? "archived" : null,
            deletedAt: target.deleted ? "deleted" : null,
          },
          runs: [
            {
              id: RunId.make("existing-run"),
              ordinal: 1,
              status: target.status,
              providerThreadId: "owner",
            },
          ],
          providerThreads: [{ id: "owner", goal: target.paused ? { status: "paused" } : null }],
        };
      }),
    sendToThread: (input: Threads.ThreadManagementSendInput) =>
      Effect.gen(function* () {
        sends.push(input);
        receipts.add(input.commandId);
        if (target.failAfterCommit)
          return yield* new LinearIntegrationError({ reason: "target_unavailable" });
        return { run: { id: RunId.make("existing-run") }, delivery: "steered" };
      }),
  } as unknown as Threads.ThreadManagementService["Service"];
  const infrastructure = ServerConfig.layerTest(process.cwd(), { prefix: "linear-settings-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const dependencies = Layer.mergeAll(
    infrastructure,
    Secrets.layer.pipe(Layer.provide(infrastructure)),
    Layer.succeed(LinearApi.LinearApi, api),
    Layer.succeed(Threads.ThreadManagementService, threads),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-environment")),
      getDescriptor: Effect.die("unused"),
    }),
    Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
    Layer.succeed(
      LinearIntegration.LinearOAuthConfig,
      configured ? oauth : { clientId: "", redirectUri: "" },
    ),
  );
  const layer = LinearIntegration.layer.pipe(Layer.provideMerge(dependencies));
  return { calls, sends, receipts, upstream, target, layer };
}

const connect = Effect.gen(function* () {
  const service = yield* LinearIntegration.LinearIntegration;
  yield* service.action({ type: "enable", enabled: true });
  const started = yield* service.action({ type: "connect" });
  const url = new URL(started.authorizeUrl!);
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "read");
  yield* service.callback({ code: "fixture-code", state: url.searchParams.get("state")! });
  yield* service.action({ type: "bind", issueId: "WEA-14", projectId, threadId });
  yield* service.action({ type: "webhook-secret", secret: "fixture-signing-secret" });
});

const event = (actor = "human-actor", overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const body = new TextEncoder().encode(
      encode({
        type: "Comment",
        action: "create",
        organizationId: "workspace-one",
        webhookTimestamp: yield* Clock.currentTimeMillis,
        actor: { id: actor },
        data: {
          id: "comment-one",
          issueId: "issue-one",
          body: "Please use the bound existing thread.",
        },
        ...overrides,
      }),
    );
    return {
      body,
      headers: {
        "linear-delivery": "provider-delivery-one",
        "linear-signature": NodeCrypto.createHmac("sha256", "fixture-signing-secret")
          .update(body)
          .digest("hex"),
      },
    };
  });

it.effect("OFF performs no provider requests, callbacks, dispatch or scheduler work", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* LinearIntegration.LinearIntegration;
    assert.isFalse((yield* service.settings).enabled);
    yield* service.drain;
    assert.equal(yield* service.receive({ headers: {}, body: new Uint8Array() }), "disabled");
    const rejected = yield* service.action({ type: "connect" }).pipe(Effect.flip);
    assert.equal(rejected.reason, "disabled");
    yield* service.callback({ code: "unrequested", state: "unrequested" }).pipe(Effect.flip);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.sends, []);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("an unregistered OAuth app is a local Connect blocker with zero provider calls", () => {
  const f = fixture(false);
  return Effect.gen(function* () {
    const service = yield* LinearIntegration.LinearIntegration;
    yield* service.action({ type: "enable", enabled: true });
    assert.equal(
      (yield* service.action({ type: "connect" }).pipe(Effect.flip)).reason,
      "oauth_unconfigured",
    );
    assert.deepEqual(f.calls, []);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect(
  "OAuth state is one-use; connection metadata and state files contain no credentials",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* LinearIntegration.LinearIntegration;
      yield* service.action({ type: "enable", enabled: true });
      const started = yield* service.action({ type: "connect" });
      const state = new URL(started.authorizeUrl!).searchParams.get("state")!;
      yield* service.callback({ code: "fixture-code", state: "wrong-state" }).pipe(Effect.flip);
      assert.deepEqual(f.calls, []);
      yield* service.callback({ code: "fixture-code", state });
      yield* service.callback({ code: "fixture-code", state }).pipe(Effect.flip);
      assert.deepEqual(f.calls, ["token", "identity"]);
      const status = yield* service.settings;
      assert.equal(status.workspace?.actorId, "our-app-actor");
      assert.isFalse(encode(status).includes("fixture-private-token"));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      assert.isFalse(
        (yield* fs.readFileString(path.join(config.stateDir, "linear-integration.json"))).includes(
          "fixture-private-token",
        ),
      );
      assert.equal(
        (yield* fs.stat(path.join(config.secretsDir, "linear-oauth-token.bin"))).mode & 0o777,
        0o600,
      );
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect(
  "a signed bound event durably deduplicates delivery IDs and digests and steers once",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* LinearIntegration.LinearIntegration;
      yield* connect;
      const request = yield* event();
      assert.equal(yield* service.receive(request), "accepted");
      assert.equal((yield* service.settings).deliveries[0]?.outcome, "pending");
      assert.equal(f.sends.length, 0);
      yield* service.drain;
      assert.equal(f.sends.length, 1);
      assert.equal(f.sends[0]?.mode, "steer");
      assert.equal(f.sends[0]?.threadId, threadId);
      assert.equal((yield* service.settings).deliveries[0]?.outcome, "delivered");
      assert.equal((yield* service.settings).deliveries[0]?.runId, "existing-run");
      assert.equal(yield* service.receive(request), "duplicate");
      assert.equal(
        yield* service.receive({
          ...request,
          headers: { ...request.headers, "linear-delivery": "changed-header" },
        }),
        "duplicate",
      );
      const reopened = Context.get(
        yield* Layer.build(LinearIntegration.layer),
        LinearIntegration.LinearIntegration,
      );
      assert.equal(yield* reopened.receive(request), "duplicate");
      yield* reopened.drain;
      assert.equal(f.sends.length, 1);
      const status = yield* reopened.settings;
      assert.equal(status.bindings[0]?.workspaceId, "workspace-one");
      assert.equal(status.bindings[0]?.teamId, "team-one");
      assert.equal(status.bindings[0]?.linearProjectId, "linear-project-one");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect(
  "own replies, unbound events and invalid signatures never request or steer an issue",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* LinearIntegration.LinearIntegration;
      yield* connect;
      const before = f.calls.length;
      assert.equal(yield* service.receive(yield* event("our-app-actor")), "accepted");
      yield* service.drain;
      assert.equal((yield* service.settings).deliveries[0]?.outcome, "own_reply");
      const request = yield* event();
      assert.equal(
        yield* service.receive({
          ...request,
          headers: { ...request.headers, "linear-signature": "invalid" },
        }),
        "rejected",
      );
      assert.equal(
        yield* service.receive(yield* event("human-actor", { organizationId: "other-workspace" })),
        "rejected",
      );
      assert.equal(
        yield* service.receive(
          yield* event("human-actor", {
            webhookTimestamp: (yield* Clock.currentTimeMillis) - 60_001,
          }),
        ),
        "rejected",
      );
      assert.equal(f.calls.length, before);
      assert.equal(f.sends.length, 0);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect.each(["paused", "archived", "deleted", "cancelled", "interrupted", "completed"] as const)(
  "holds %s targets without waking them",
  (reason) => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* LinearIntegration.LinearIntegration;
      yield* connect;
      if (reason === "paused") f.target.paused = true;
      else if (reason === "archived") f.target.archived = true;
      else if (reason === "deleted") f.target.deleted = true;
      else f.target.status = reason;
      const before = f.calls.length;
      yield* service.receive(yield* event());
      yield* service.drain;
      assert.equal(
        (yield* service.settings).deliveries[0]?.outcome,
        reason === "completed" ? "idle" : "stopped",
      );
      assert.equal(f.calls.length, before);
      assert.equal(f.sends.length, 0);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect(
  "offline delivery is retained; retry is explicit and uses the same durable command",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* LinearIntegration.LinearIntegration;
      yield* connect;
      f.upstream.reason = "offline";
      yield* service.receive(yield* event());
      yield* service.drain;
      const delivery = (yield* service.settings).deliveries[0]!;
      assert.equal(delivery.outcome, "offline");
      assert.equal(f.sends.length, 0);
      const before = f.calls.length;
      yield* service.drain;
      assert.equal(f.calls.length, before);
      f.upstream.reason = null;
      yield* service.action({ type: "retry", deliveryId: delivery.id });
      assert.equal(f.sends.length, 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect("revoked and disabled installations do not replay queued work", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* LinearIntegration.LinearIntegration;
    yield* connect;
    f.upstream.reason = "revoked";
    yield* service.receive(yield* event());
    yield* service.drain;
    assert.equal((yield* service.settings).connection, "revoked");
    const before = f.calls.length;
    yield* service.drain;
    yield* service.action({ type: "enable", enabled: false });
    yield* service.action({ type: "enable", enabled: true });
    yield* service.drain;
    assert.equal(f.calls.length, before);
    assert.equal(f.sends.length, 0);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("turning OFF holds accepted work across re-enable until an explicit retry", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* LinearIntegration.LinearIntegration;
    yield* connect;
    yield* service.receive(yield* event());
    const before = f.calls.length;
    yield* service.action({ type: "enable", enabled: false });
    yield* service.drain;
    const delivery = (yield* service.settings).deliveries[0]!;
    assert.equal(delivery.outcome, "disabled");
    yield* service.action({ type: "enable", enabled: true });
    yield* service.drain;
    assert.equal(f.calls.length, before);
    assert.equal(f.sends.length, 0);
    yield* service.action({ type: "retry", deliveryId: delivery.id });
    assert.equal(f.sends.length, 1);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("a committed dispatch is not sent again after an acknowledgement failure", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* LinearIntegration.LinearIntegration;
    yield* connect;
    f.target.failAfterCommit = true;
    yield* service.receive(yield* event());
    yield* service.drain;
    const delivery = (yield* service.settings).deliveries[0]!;
    assert.equal(f.sends.length, 1);
    f.target.failAfterCommit = false;
    yield* service.action({ type: "retry", deliveryId: delivery.id });
    assert.equal(f.sends.length, 1);
    assert.equal((yield* service.settings).deliveries[0]?.outcome, "delivered");
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});
