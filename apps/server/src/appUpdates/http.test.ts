import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentHttpApi } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as AuthHttp from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AndroidAppUpdates from "./AndroidAppUpdates.ts";
import * as AndroidAppUpdatesHttp from "./http.ts";

class TestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.androidAppUpdates,
) {}

it.effect(
  "requires read permission for both endpoints before accessing host release credentials",
  () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      for (const allowed of [false, true]) {
        const calls: string[] = [];
        const service = AndroidAppUpdates.AndroidAppUpdates.of({
          releases: Effect.sync(() => {
            calls.push("index");
            return { repository: "morrowbyte/t3code", releases: [] };
          }),
          asset: (input) =>
            Effect.sync(() => {
              calls.push(`${input.releaseId}/${input.assetId}`);
              return {
                asset: { id: 20, name: "fixture.apk", size: 3, sha256: "a".repeat(64) },
                stream: Stream.succeed(new Uint8Array([1, 2, 3])),
              };
            }),
        });
        const auth = {
          authenticateHttpRequest: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("updates-test"),
              subject: "test",
              method: "bearer-access-token",
              scopes: allowed ? ["orchestration:read"] : [],
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
        const layer = HttpApiBuilder.layer(TestApi).pipe(
          Layer.provide(AndroidAppUpdatesHttp.layer),
          Layer.provide(Layer.succeed(AndroidAppUpdates.AndroidAppUpdates, service)),
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
        const app = HttpRouter.toWebHandler(layer, { disableLogger: true });
        for (const path of [
          "/api/app-updates/android/releases",
          "/api/app-updates/android/releases/10/assets/20",
        ]) {
          const response = yield* Effect.promise(() =>
            app.handler(
              new Request("http://environment.test" + path, {
                headers: { authorization: "Bearer fixture" },
              }),
              context,
            ),
          );
          expect(response.status).toBe(allowed ? 200 : 403);
          if (allowed && path.endsWith("/20")) {
            expect([
              ...new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
            ]).toEqual([1, 2, 3]);
            expect(response.headers.get("cache-control")).toBe("private, no-store");
          }
        }
        expect(calls).toEqual(allowed ? ["index", "10/20"] : []);
        yield* Effect.promise(() => app.dispose());
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
