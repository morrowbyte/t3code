import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const AndroidAppReleaseAsset = Schema.Struct({
  id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  name: Schema.String,
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AndroidAppReleaseAsset = typeof AndroidAppReleaseAsset.Type;

export const AndroidAppReleaseIndex = Schema.Struct({
  repository: Schema.Literal("morrowbyte/t3code"),
  releases: Schema.Array(
    Schema.Struct({
      id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      tagName: Schema.String,
      version: Schema.String,
      source: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
      changelog: Schema.String,
      assets: Schema.Array(AndroidAppReleaseAsset),
    }),
  ),
});
export type AndroidAppReleaseIndex = typeof AndroidAppReleaseIndex.Type;

export const AndroidAppUpdateFailureReason = Schema.Literals([
  "github_access",
  "invalid_release",
  "asset_unavailable",
  "integrity_failed",
]);

export class AndroidAppUpdateHttpError extends Schema.TaggedError<AndroidAppUpdateHttpError>()(
  "AndroidAppUpdateHttpError",
  { reason: AndroidAppUpdateFailureReason },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(AndroidAppUpdateHttpError)(this, { status: 502 });
  }

  override get message(): string {
    return `The Android update is unavailable from this environment (${this.reason}).`;
  }
}
