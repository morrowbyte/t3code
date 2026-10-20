import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  requestEnvironmentAndroidAppReleases,
  consumeEnvironmentAndroidAppAsset,
} from "./androidAppUpdates.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("updates-destination"),
  label: "Updates",
  httpBaseUrl: "https://destination.test/",
  wsBaseUrl: "wss://destination.test/ws",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl,
  httpAuthorization: { _tag: "Bearer", token: "fixture-environment-token" },
  target,
};
const connection = { prepared, signer: Option.none(), remoteAuthorization: Option.none() };

it.effect(
  "uses the selected environment and normal authorization for index and streamed asset",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ path: string; authorization: string | null }> = [];
      const fetchFn: typeof fetch = (url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push({ path, authorization: new Headers(init?.headers).get("authorization") });
        return Promise.resolve(
          path.endsWith("/assets/20")
            ? new Response(new Uint8Array([1, 2, 3]))
            : Response.json({ repository: "morrowbyte/t3code", releases: [] }),
        );
      };
      const layer = RpcHttp.layerRemoteHttpClient(fetchFn);
      const index = yield* requestEnvironmentAndroidAppReleases(connection).pipe(
        Effect.provide(layer),
      );
      expect(index.releases).toEqual([]);
      const parts = yield* consumeEnvironmentAndroidAppAsset({
        ...connection,
        releaseId: "10",
        assetId: "20",
        consume: (response) => Stream.runCollect(response.stream),
      }).pipe(Effect.provide(layer));
      expect([...parts].flatMap((part) => [...part])).toEqual([1, 2, 3]);
      expect(calls).toEqual([
        {
          path: "/api/app-updates/android/releases",
          authorization: "Bearer fixture-environment-token",
        },
        {
          path: "/api/app-updates/android/releases/10/assets/20",
          authorization: "Bearer fixture-environment-token",
        },
      ]);
    }),
);

it.effect("cancelling download consumption cancels the underlying body", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const cancelled = Promise.withResolvers<void>();
    let readingBody = false;
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new Uint8Array([1])),
            pull: () => {
              return new Promise<void>(() => {});
            },
            cancel: () => cancelled.resolve(),
          }),
        ),
      );
    const fiber = yield* consumeEnvironmentAndroidAppAsset({
      ...connection,
      releaseId: "10",
      assetId: "20",
      consume: (response) =>
        Stream.runDrain(
          response.stream.pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                readingBody = true;
              }).pipe(Effect.andThen(Deferred.succeed(reading, undefined))),
            ),
          ),
        ),
    }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)), Effect.forkChild);
    yield* Deferred.await(reading);
    yield* Fiber.interrupt(fiber);
    yield* Effect.promise(() => cancelled.promise);
    expect(readingBody).toBe(true);
  }),
);
