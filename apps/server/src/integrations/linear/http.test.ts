import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentHttpApi,
  EnvironmentId,
  type LinearSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as AuthHttp from "../../auth/http.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as LinearIntegration from "./LinearIntegration.ts";
import * as LinearHttp from "./http.ts";

class LinearTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.linear)
  .add(EnvironmentHttpApi.groups.linearIngress) {}
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
function fixture(scopes: ReadonlyArray<string>, enabled = false) {
  const received: Uint8Array[] = [];
  const actions: string[] = [];
  const settings: LinearSettings = {
    enabled,
    environmentId: EnvironmentId.make("fixture"),
    oauthConfigured: false,
    webhookConfigured: false,
    connection: "disconnected",
    workspace: null,
    bindings: [],
    deliveries: [],
  };
  const service = LinearIntegration.LinearIntegration.of({
    settings: Effect.succeed(settings),
    action: (input) =>
      Effect.sync(() => {
        actions.push(input.type);
        return { settings };
      }),
    callback: () => Effect.void,
    receive: (input) =>
      Effect.sync(() => {
        received.push(input.body);
        return "accepted" as const;
      }),
    drain: Effect.void,
  });
  const auth = {
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("linear-test"),
        subject: "test",
        method: "bearer-access-token",
        scopes,
      }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  const layer = HttpApiBuilder.layer(LinearTestApi).pipe(
    Layer.provide(LinearHttp.layer),
    Layer.provide(Layer.succeed(LinearIntegration.LinearIntegration, service)),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
    Layer.provide(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { ...HttpRouter.toWebHandler(layer, { disableLogger: true }), received, actions };
}

it.effect("settings writes and delivery require destination scopes", () =>
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const readOnly = fixture(["orchestration:read"]);
    const post = (type: "enable" | "sync") =>
      new Request("http://environment.test/api/integrations/linear", {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        body: encode({
          action: type === "enable" ? { type, enabled: true } : { type, bindingId: "bound" },
        }),
      });
    expect((yield* Effect.promise(() => readOnly.handler(post("enable"), context))).status).toBe(
      403,
    );
    expect(readOnly.actions).toEqual([]);
    yield* Effect.promise(() => readOnly.dispose());
    const settingsWriter = fixture(["orchestration:read", "settings:write"]);
    expect(
      (yield* Effect.promise(() => settingsWriter.handler(post("enable"), context))).status,
    ).toBe(200);
    expect(
      (yield* Effect.promise(() => settingsWriter.handler(post("sync"), context))).status,
    ).toBe(403);
    expect(settingsWriter.actions).toEqual(["enable"]);
    yield* Effect.promise(() => settingsWriter.dispose());
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "OFF refuses events before reading them; enabled ingress keeps exact raw bytes and returns 200",
  () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const bytes = new TextEncoder().encode('{ "signed": true }\n');
      const post = () =>
        new Request("http://environment.test/api/integrations/linear/events", {
          method: "POST",
          body: bytes,
        });
      const off = fixture([]);
      expect((yield* Effect.promise(() => off.handler(post(), context))).status).toBe(404);
      expect(off.received).toEqual([]);
      yield* Effect.promise(() => off.dispose());
      const on = fixture([], true);
      expect((yield* Effect.promise(() => on.handler(post(), context))).status).toBe(200);
      expect(on.received[0]).toEqual(bytes);
      const large = new Request("http://environment.test/api/integrations/linear/events", {
        method: "POST",
        headers: { "content-length": "1048577" },
      });
      expect((yield* Effect.promise(() => on.handler(large, context))).status).toBe(413);
      expect(on.received.length).toBe(1);
      yield* Effect.promise(() => on.dispose());
    }).pipe(Effect.provide(NodeServices.layer)),
);
