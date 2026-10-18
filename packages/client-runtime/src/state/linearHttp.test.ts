import { expect, it } from "@effect/vitest";
import { EnvironmentId, LinearIntegrationError, type LinearSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import { requestEnvironmentLinear } from "./linearHttp.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("linear-destination"),
  label: "Linear destination",
  httpBaseUrl: "https://destination.example.test/base",
  wsBaseUrl: "wss://destination.example.test/ws",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl,
  httpAuthorization: { _tag: "Bearer", token: "fixture-environment-auth" },
  target,
};
const settings: LinearSettings = {
  enabled: false,
  environmentId: target.environmentId,
  oauthConfigured: false,
  webhookConfigured: false,
  connection: "disconnected",
  workspace: null,
  bindings: [],
  deliveries: [],
};
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.effect("uses the selected authenticated environment for status and optional actions", () =>
  Effect.gen(function* () {
    const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    const fetchFn: typeof fetch = (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      return Promise.resolve(
        Response.json(
          init?.method === "POST" ? { settings: { ...settings, enabled: true } } : settings,
        ),
      );
    };
    const input = { prepared, signer: Option.none(), remoteAuthorization: Option.none() };
    const read = yield* requestEnvironmentLinear(input).pipe(
      Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
    );
    expect(read.settings.enabled).toBe(false);
    const update = yield* requestEnvironmentLinear({
      ...input,
      action: { type: "enable", enabled: true },
    }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));
    expect(update.settings.enabled).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    for (const call of calls) {
      expect(call.url).toBe("https://destination.example.test/api/integrations/linear");
      expect(call.headers.get("authorization")).toBe("Bearer fixture-environment-auth");
    }
    const body = calls[1]!.body;
    expect(
      decode(body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body)),
    ).toEqual({ action: { type: "enable", enabled: true } });
  }),
);

it.effect.each(["offline", "revoked", "oauth_unconfigured"] as const)(
  "preserves the bounded %s failure without an auth retry",
  (reason) =>
    Effect.gen(function* () {
      let count = 0;
      const fetchFn: typeof fetch = () => {
        count++;
        return Promise.resolve(
          Response.json({ _tag: "LinearIntegrationError", reason }, { status: 500 }),
        );
      };
      const error = yield* requestEnvironmentLinear({
        prepared,
        signer: Option.none(),
        remoteAuthorization: Option.none(),
        action: { type: "connect" },
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)), Effect.flip);
      expect(error).toBeInstanceOf(LinearIntegrationError);
      expect(error).toMatchObject({ reason });
      expect(count).toBe(1);
    }),
);
