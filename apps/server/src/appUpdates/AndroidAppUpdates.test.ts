import { expect, it } from "@effect/vitest";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as AndroidAppUpdates from "./AndroidAppUpdates.ts";

const bytes = new TextEncoder().encode("signed APK fixture bytes");
const digest = "cad5053d1e4695d837497eccb744f0016d82fa2362fe2b9cd01a446030d6e824";
const version = "0.1.2-nightly.20261019.59";
function release(releaseVersion = version) {
  const name = `Morrowbyte-${releaseVersion}-android-arm64.apk`;
  return {
    id: 10,
    tag_name: "v" + releaseVersion,
    target_commitish: "a".repeat(40),
    draft: false,
    prerelease: true,
    published_at: "2026-10-19T01:18:17Z",
    body: "Original release notes\nwith whitespace.\n",
    assets: [name, name + ".json", name + ".sha256"].map((name, i) => ({
      id: 20 + i,
      name,
      size: bytes.length,
      digest: "sha256:" + digest,
    })),
  };
}

function fixture(
  releases = [release()],
  fetchFn: typeof fetch = () => Promise.resolve(new Response(bytes)),
  pages?: ReadonlyArray<ReadonlyArray<ReturnType<typeof release>>>,
) {
  const paths: string[] = [];
  const github = GitHubRest.GitHubRest.of({
    credential: () =>
      Effect.succeed({ token: Redacted.make("fixture-host-secret"), fingerprint: "fixture" }),
    rest: (input) =>
      Effect.sync(() => {
        paths.push(input.path);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            input.path.includes("?")
              ? (pages?.[
                  Number(
                    new URL("https://api.github.com/" + input.path).searchParams.get("page") ?? "1",
                  ) - 1
                ] ?? releases)
              : releases[0],
          ),
          truncated: false,
          invalidUtf8: false,
        };
      }),
  });
  return {
    paths,
    layer: AndroidAppUpdates.layer.pipe(
      Layer.provide(Layer.succeed(GitHubRest.GitHubRest, github)),
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
      ),
    ),
  };
}

it.effect(
  "keeps the known nightly and namespaced Android channels, excluding drafts and unbound assets",
  () =>
    Effect.gen(function* () {
      const good = release();
      const badDigest = release();
      badDigest.assets[0]!.digest = "";
      const f = fixture([
        good,
        { ...good, id: 11, tag_name: "android/v" + version, prerelease: false },
        { ...good, draft: true },
        { ...good, tag_name: "v9.0.0-beta.1" },
        { ...good, tag_name: "android/v" + version, prerelease: true },
        badDigest,
        { ...good, assets: [...good.assets, good.assets[0]!] },
      ]);
      const index = yield* AndroidAppUpdates.AndroidAppUpdates.pipe(
        Effect.flatMap((service) => service.releases),
        Effect.provide(f.layer),
      );
      expect(index.releases.map((r) => r.id)).toEqual([10, 11]);
      expect(index.releases[0]!.changelog).toBe(good.body);
      expect(index.releases[0]!.assets).toHaveLength(3);
      expect(f.paths).toEqual(["repos/morrowbyte/t3code/releases?per_page=30"]);
    }),
);

it.effect("finds the Android release beyond a full ineligible first page", () =>
  Effect.gen(function* () {
    const good = release();
    const f = fixture([good], undefined, [
      Array.from({ length: 30 }, () => ({ ...good, draft: true })),
      [good],
    ]);
    const index = yield* AndroidAppUpdates.AndroidAppUpdates.pipe(
      Effect.flatMap((service) => service.releases),
      Effect.provide(f.layer),
    );
    expect(index.releases.map((entry) => entry.id)).toEqual([good.id]);
    expect(f.paths).toEqual([
      "repos/morrowbyte/t3code/releases?per_page=30",
      "repos/morrowbyte/t3code/releases?per_page=30&page=2",
    ]);
  }),
);

it.effect("returns an empty index only after reaching the end of release history", () =>
  Effect.gen(function* () {
    const f = fixture([release()], undefined, [
      Array.from({ length: 30 }, () => ({ ...release(), draft: true })),
      [],
    ]);
    const index = yield* AndroidAppUpdates.AndroidAppUpdates.pipe(
      Effect.flatMap((service) => service.releases),
      Effect.provide(f.layer),
    );
    expect(index.releases).toEqual([]);
    expect(f.paths).toHaveLength(2);
  }),
);

it.effect("fails the check instead of reporting current when its request budget is exhausted", () =>
  Effect.gen(function* () {
    const f = fixture(Array.from({ length: 30 }, () => ({ ...release(), draft: true })));
    const error = yield* AndroidAppUpdates.AndroidAppUpdates.pipe(
      Effect.flatMap((service) => service.releases),
      Effect.provide(f.layer),
      Effect.flip,
    );
    expect(error.reason).toBe("invalid_release");
    expect(f.paths).toHaveLength(10);
  }),
);

it.effect.each(["0.1.3-nightly.20261020.60", "1.0.0-nightly.20261020.61"])(
  "accepts the all-platform nightly channel after the base version advances to %s",
  (nextVersion) =>
    Effect.gen(function* () {
      const f = fixture([release(nextVersion)]);
      const index = yield* AndroidAppUpdates.AndroidAppUpdates.pipe(
        Effect.flatMap((service) => service.releases),
        Effect.provide(f.layer),
      );
      expect(index.releases).toHaveLength(1);
      expect(index.releases[0]).toMatchObject({
        tagName: "v" + nextVersion,
        version: nextVersion,
      });
    }),
);

it.effect.each([
  { assetIndex: 0, limit: 250 * 1024 * 1024 },
  { assetIndex: 1, limit: 64_000 },
])("keeps the client size boundary for asset $assetIndex", ({ assetIndex, limit }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const good = release();
      good.assets[assetIndex]!.size = limit;
      const oversized = release();
      oversized.id = 11;
      oversized.assets[assetIndex]!.size = limit + 1;
      let downloads = 0;
      const f = fixture([oversized, good], () => {
        downloads++;
        return Promise.resolve(new Response(bytes));
      });
      yield* Effect.gen(function* () {
        const service = yield* AndroidAppUpdates.AndroidAppUpdates;
        const index = yield* service.releases;
        expect(index.releases.map((entry) => entry.id)).toEqual([good.id]);
        const error = yield* service
          .asset({ releaseId: "11", assetId: String(oversized.assets[assetIndex]!.id) })
          .pipe(Effect.flip);
        expect(error.reason).toBe("asset_unavailable");
      }).pipe(Effect.provide(f.layer));
      expect(downloads).toBe(0);
    }),
  ),
);

it.effect(
  "revalidates release membership and refuses draft/foreign asset IDs before binary fetch",
  () =>
    Effect.gen(function* () {
      let downloads = 0;
      const f = fixture([{ ...release(), draft: true }], () => {
        downloads++;
        return Promise.resolve(new Response(bytes));
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AndroidAppUpdates.AndroidAppUpdates;
          for (const input of [
            { releaseId: "10", assetId: "20" },
            { releaseId: "10", assetId: "999" },
            { releaseId: "../10", assetId: "20" },
          ]) {
            const error = yield* service.asset(input).pipe(Effect.flip);
            expect(error.reason).toBe("asset_unavailable");
          }
        }).pipe(Effect.provide(f.layer)),
      );
      expect(downloads).toBe(0);
      expect(f.paths).toHaveLength(2);
    }),
);

it.effect("streams exact digest-bound bytes and removes host credentials on the CDN redirect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<{
        host: string;
        auth: string | null;
        redirect: string | undefined;
      }> = [];
      const f = fixture([release()], (url, init) => {
        const host = new URL(String(url)).hostname;
        calls.push({
          host,
          auth: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
        });
        return Promise.resolve(
          host === "api.github.com"
            ? new Response(null, {
                status: 302,
                headers: {
                  location:
                    "https://release-assets.githubusercontent.com/fixture?signature=private",
                },
              })
            : new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
        );
      });
      const value = yield* Effect.gen(function* () {
        const service = yield* AndroidAppUpdates.AndroidAppUpdates;
        const download = yield* service.asset({ releaseId: "10", assetId: "20" });
        return yield* Stream.runCollect(download.stream);
      }).pipe(Effect.provide(f.layer));
      expect([...value].flatMap((part) => [...part])).toEqual([...bytes]);
      expect(calls).toEqual([
        { host: "api.github.com", auth: "Bearer fixture-host-secret", redirect: "manual" },
        { host: "release-assets.githubusercontent.com", auth: null, redirect: "manual" },
      ]);
    }),
  ),
);

it.effect.each(["http://release-assets.githubusercontent.com/x", "https://evil.example/x"])(
  "rejects the unauthorized redirect %s",
  (location) =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const f = fixture([release()], () => {
          calls++;
          return Promise.resolve(new Response(null, { status: 302, headers: { location } }));
        });
        const error = yield* AndroidAppUpdates.AndroidAppUpdates.pipe(
          Effect.flatMap((service) => service.asset({ releaseId: "10", assetId: "20" })),
          Effect.provide(f.layer),
          Effect.flip,
        );
        expect(error.reason).toBe("asset_unavailable");
        expect(calls).toBe(1);
      }),
    ),
);

it.effect.each([new TextEncoder().encode("tampered"), new Uint8Array(bytes.length + 1)])(
  "refuses incomplete, oversized or altered asset streams",
  (body) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture([release()], () => Promise.resolve(new Response(body)));
        const error = yield* AndroidAppUpdates.AndroidAppUpdates.pipe(
          Effect.flatMap((service) => service.asset({ releaseId: "10", assetId: "20" })),
          Effect.flatMap((download) => Stream.runDrain(download.stream)),
          Effect.provide(f.layer),
          Effect.flip,
        );
        expect(error.reason).toBe("integrity_failed");
      }),
    ),
);

it.effect("closing the download scope aborts the upstream request", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const aborted = Promise.withResolvers<void>();
    const f = fixture([release()], (_url, init) => {
      init?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new Uint8Array([1])),
            pull: () => Promise.withResolvers<void>().promise,
          }),
        ),
      );
    });
    const fiber = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* AndroidAppUpdates.AndroidAppUpdates;
        const download = yield* service.asset({ releaseId: "10", assetId: "20" });
        yield* Stream.runDrain(
          download.stream.pipe(Stream.tap(() => Deferred.succeed(reading, undefined))),
        );
      }).pipe(Effect.provide(f.layer)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(reading);
    yield* Fiber.interrupt(fiber);
    yield* Effect.promise(() => aborted.promise);
  }),
);
