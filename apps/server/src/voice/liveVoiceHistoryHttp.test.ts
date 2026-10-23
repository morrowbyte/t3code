import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as History from "./LiveVoiceHistory.ts";
import * as HistoryHttp from "./liveVoiceHistoryHttp.ts";

class HistoryApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.liveVoiceHistory,
) {}

const handlerFor = (scopes: ReadonlyArray<string>, authenticated = true) => {
  let reads = 0;
  const auth = {
    authenticateHttpRequest: () =>
      authenticated
        ? Effect.succeed({
            sessionId: AuthSessionId.make("history-client"),
            subject: "history-client",
            method: "bearer-access-token",
            scopes,
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  const history: History.LiveVoiceHistory["Service"] = {
    record: () => Effect.void,
    list: (target) =>
      Effect.sync(() => {
        reads++;
        expect(target.environmentId).toBe("destination-env");
        return { calls: [], nextBefore: null, persistenceAvailable: true };
      }),
    transcript: () => Effect.fail(new History.LiveVoiceHistoryError({ reason: "not_found" })),
  };
  const environment = {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("destination-env")),
  } as ServerEnvironment.ServerEnvironment["Service"];
  const layer = HttpApiBuilder.layer(HistoryApi).pipe(
    Layer.provide(HistoryHttp.layer),
    Layer.provide(Layer.succeed(History.LiveVoiceHistory, history)),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
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
  return { ...HttpRouter.toWebHandler(layer, { disableLogger: true }), reads: () => reads };
};

it("rejects missing credentials and missing read scope before accessing history", async () => {
  for (const [scopes, authenticated, status] of [
    [[], false, 401],
    [[], true, 403],
    [["orchestration:read"], true, 200],
  ] as const) {
    const route = handlerFor(scopes, authenticated);
    try {
      const response = await route.handler(
        new Request("http://history.test/api/voice/threads/fixture-thread/calls"),
        Context.empty(),
      );
      expect(response.status).toBe(status);
      expect(route.reads()).toBe(status === 200 ? 1 : 0);
      if (status === 200) expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await route.dispose();
    }
  }
});

it("returns a bounded not-found error for a call outside the requested thread", async () => {
  const route = handlerFor(["orchestration:read"]);
  try {
    const response = await route.handler(
      new Request("http://history.test/api/voice/threads/other-thread/calls/private-call/1"),
      Context.empty(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      _tag: "EnvironmentResourceNotFoundError",
      reason: "thread_not_found",
    });
  } finally {
    await route.dispose();
  }
});
