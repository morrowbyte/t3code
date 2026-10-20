// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto has no incremental digest; APK verification must stay bounded while streaming.
import * as NodeCrypto from "node:crypto";
import {
  AndroidAppUpdateFailureReason,
  type AndroidAppReleaseIndex,
  type AndroidAppReleaseAsset,
} from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const REPOSITORY = "morrowbyte/t3code";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const MAX_APK_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set([
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const GitHubAsset = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  size: Schema.Number,
  digest: Schema.optional(Schema.NullOr(Schema.String)),
});
const GitHubRelease = Schema.Struct({
  id: Schema.Number,
  tag_name: Schema.String,
  target_commitish: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  assets: Schema.Array(GitHubAsset),
});

export class AndroidAppUpdateFailure extends Schema.TaggedError<AndroidAppUpdateFailure>()(
  "AndroidAppUpdateFailure",
  { reason: AndroidAppUpdateFailureReason, cause: Schema.optional(Schema.Defect()) },
) {}

export class AndroidAppUpdates extends Context.Service<
  AndroidAppUpdates,
  {
    readonly releases: Effect.Effect<AndroidAppReleaseIndex, AndroidAppUpdateFailure>;
    readonly asset: (input: {
      readonly releaseId: string;
      readonly assetId: string;
    }) => Effect.Effect<
      {
        readonly asset: AndroidAppReleaseAsset;
        readonly stream: Stream.Stream<Uint8Array, AndroidAppUpdateFailure>;
      },
      AndroidAppUpdateFailure,
      Scope.Scope
    >;
  }
>()("t3/appUpdates/AndroidAppUpdates") {}

function approvedRelease(
  release: typeof GitHubRelease.Type,
): AndroidAppReleaseIndex["releases"][number] | null {
  if (
    release.draft ||
    !release.published_at ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0
  )
    return null;
  const nightly = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/.exec(release.tag_name);
  const android = /^android\/v(\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?)$/.exec(release.tag_name);
  const version =
    nightly && release.prerelease ? nightly[1] : android && !release.prerelease ? android[1] : null;
  if (!version || !/^[a-f0-9]{40}$/.test(release.target_commitish)) return null;
  const name = `Morrowbyte-${version}-android-arm64.apk`;
  const wanted = new Map([
    [name, MAX_APK_BYTES],
    [name + ".json", 64_000],
    [name + ".sha256", 1024],
  ]);
  const assets: AndroidAppReleaseAsset[] = [];
  for (const [file, limit] of wanted) {
    const matches = release.assets.filter((asset) => asset.name === file);
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      !asset ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > limit ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
    )
      return null;
    assets.push({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      sha256: String(asset.digest).slice(7),
    });
  }
  return {
    id: release.id,
    tagName: release.tag_name,
    version,
    source: release.target_commitish,
    changelog: release.body ?? "",
    assets,
  };
}

const make = Effect.gen(function* () {
  const github = yield* GitHubRest.GitHubRest;
  const http = yield* HttpClient.HttpClient;
  const read = (path: string) =>
    github
      .rest({
        host: "github.com",
        operation: "AndroidAppUpdates.read",
        path: `repos/${REPOSITORY}/${path}`,
        maxResponseBytes: 2 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError((cause) => new AndroidAppUpdateFailure({ reason: "github_access", cause })),
        Effect.flatMap((response) =>
          response.truncated
            ? Effect.fail(new AndroidAppUpdateFailure({ reason: "invalid_release" }))
            : Effect.succeed(response.body),
        ),
      );

  const releases = Effect.gen(function* () {
    for (let page = 1; page <= 10; page++) {
      const batch = yield* read(`releases?per_page=30${page === 1 ? "" : `&page=${page}`}`).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(GitHubRelease))),
        ),
      );
      const approved = batch.flatMap((release) => {
        const entry = approvedRelease(release);
        return entry ? [entry] : [];
      });
      if (approved.length > 0 || batch.length < 30)
        return { repository: REPOSITORY, releases: approved } as const;
    }
    // A bounded check must fail rather than claim current with unsearched history.
    return yield* new AndroidAppUpdateFailure({ reason: "invalid_release" });
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(AndroidAppUpdateFailure)(cause)
        ? cause
        : new AndroidAppUpdateFailure({ reason: "invalid_release", cause }),
    ),
  );

  const asset = Effect.fn("AndroidAppUpdates.asset")(function* (input: {
    readonly releaseId: string;
    readonly assetId: string;
  }) {
    if (
      ![input.releaseId, input.assetId].every(
        (id) => /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)),
      )
    )
      return yield* new AndroidAppUpdateFailure({ reason: "asset_unavailable" });
    const release = yield* read(`releases/${input.releaseId}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubRelease))),
      Effect.map(approvedRelease),
      Effect.mapError((cause) =>
        Schema.is(AndroidAppUpdateFailure)(cause)
          ? cause
          : new AndroidAppUpdateFailure({ reason: "invalid_release", cause }),
      ),
    );
    const selected =
      release?.id === Number(input.releaseId)
        ? release.assets.find((candidate) => candidate.id === Number(input.assetId))
        : undefined;
    if (!selected) return yield* new AndroidAppUpdateFailure({ reason: "asset_unavailable" });
    const credential = yield* github
      .credential("github.com")
      .pipe(
        Effect.mapError((cause) => new AndroidAppUpdateFailure({ reason: "github_access", cause })),
      );
    let target = `${API}/releases/assets/${selected.id}`;
    for (let hop = 0; hop <= 3; hop += 1) {
      const parsed = new URL(target);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        !DOWNLOAD_HOSTS.has(parsed.hostname)
      )
        return yield* new AndroidAppUpdateFailure({ reason: "asset_unavailable" });
      const response = yield* HttpClient.withScope(http)
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              accept: "application/octet-stream",
              "accept-encoding": "identity",
              ...(parsed.hostname === "api.github.com"
                ? { authorization: `Bearer ${Redacted.value(credential.token)}` }
                : {}),
            }),
          ),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(
            (cause) => new AndroidAppUpdateFailure({ reason: "asset_unavailable", cause }),
          ),
        );
      if (response.status >= 300 && response.status < 400) {
        if (!response.headers.location || !URL.canParse(response.headers.location, target)) break;
        target = new URL(response.headers.location, target).toString();
        continue;
      }
      if (
        response.status !== 200 ||
        (response.headers["content-length"] !== undefined &&
          Number(response.headers["content-length"]) !== selected.size)
      )
        break;
      const hash = NodeCrypto.createHash("sha256");
      let count = 0;
      const stream = response.stream.pipe(
        Stream.mapError(
          (cause) => new AndroidAppUpdateFailure({ reason: "asset_unavailable", cause }),
        ),
        Stream.mapEffect((chunk) =>
          Effect.gen(function* () {
            count += chunk.length;
            if (count > selected.size)
              return yield* new AndroidAppUpdateFailure({ reason: "integrity_failed" });
            hash.update(chunk);
            return chunk;
          }),
        ),
        Stream.concat(
          Stream.fromEffect(
            Effect.suspend(() =>
              count === selected.size && hash.digest("hex") === selected.sha256
                ? Effect.void
                : Effect.fail(new AndroidAppUpdateFailure({ reason: "integrity_failed" })),
            ),
          ).pipe(Stream.drain),
        ),
      );
      return { asset: selected, stream };
    }
    return yield* new AndroidAppUpdateFailure({ reason: "asset_unavailable" });
  });
  return AndroidAppUpdates.of({ releases, asset });
});

export const layer = Layer.effect(AndroidAppUpdates, make);
