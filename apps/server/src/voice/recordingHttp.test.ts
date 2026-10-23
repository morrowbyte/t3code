import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentHttpApi, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as AuthHttp from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as VoiceRecordingService from "./VoiceRecordingService.ts";
import * as RecordingHttp from "./recordingHttp.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.voiceRecording) {}
const settings = {
  enabled: false,
  directory: "/private/fixture/voice-recordings",
  hostLabel: "fixture",
  retentionDays: 3,
};
const route = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
  const observed: string[] = [];
  const layer = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(RecordingHttp.layer),
    Layer.provide(
      Layer.succeed(VoiceRecordingService.VoiceRecordingService, {
        settings: () => Effect.succeed(settings),
        updateSettings: (_session, enabled) =>
          Effect.sync(() => {
            observed.push("update");
            return { ...settings, enabled };
          }),
        start: () => Effect.die("unreachable fixture"),
        append: () =>
          Effect.sync(() => {
            observed.push("append");
          }),
        finish: () => Effect.void,
        list: () =>
          Effect.sync(() => {
            observed.push("list");
            return [];
          }),
        file: () => Effect.die("unreachable fixture"),
        cleanup: Effect.void,
      }),
    ),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(
      Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
        authenticateHttpRequest: () =>
          Effect.succeed({
            sessionId: AuthSessionId.make("fixture-session"),
            subject: "fixture",
            method: "bearer-access-token",
            scopes,
          }),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
    ),
  );
  const provided = layer.pipe(
    Layer.provide(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { ...HttpRouter.toWebHandler(provided, { disableLogger: true }), observed };
};
it.effect("enforces settings-write, operate and read separately before entering the service", () =>
  Effect.gen(function* () {
    const readonly = route(["orchestration:read"]);
    const settingsResponse = yield* Effect.promise(() =>
      readonly.handler(new Request("http://fixture.test/api/voice/recordings/settings")),
    );
    expect(settingsResponse.headers.get("cache-control")).toBe("private, no-store");
    const denied = yield* Effect.promise(() =>
      readonly.handler(
        new Request("http://fixture.test/api/voice/recordings/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
      ),
    );
    expect(denied.status).toBe(403);
    expect(readonly.observed).toEqual([]);
    const chunk = yield* Effect.promise(() =>
      readonly.handler(
        new Request("http://fixture.test/api/voice/recordings/chunk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "11111111-1111-1111-1111-111111111111",
            role: "user",
            sequence: 0,
            offsetMs: 0,
            trackStartedOffsetMs: 0,
            data: "b3B1cw==",
          }),
        }),
      ),
    );
    expect(chunk.status).toBe(403);
    expect(readonly.observed).toEqual([]);
    const writer = route(["settings:write"]);
    const allowed = yield* Effect.promise(() =>
      writer.handler(
        new Request("http://fixture.test/api/voice/recordings/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
      ),
    );
    expect(allowed.status).toBe(200);
    expect(writer.observed).toEqual(["update"]);
    const list = yield* Effect.promise(() =>
      writer.handler(new Request("http://fixture.test/api/voice/recordings")),
    );
    expect(list.status).toBe(403);
    yield* Effect.promise(() => readonly.dispose());
    yield* Effect.promise(() => writer.dispose());
  }),
);
