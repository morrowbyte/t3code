import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  AndroidAppUpdateHttpError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as AndroidAppUpdates from "./AndroidAppUpdates.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "androidAppUpdates",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* AndroidAppUpdates.AndroidAppUpdates;
    return handlers
      .handle("releases", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.andThen(service.releases),
          Effect.catchTags({
            AndroidAppUpdateFailure: (error) =>
              Effect.fail(new AndroidAppUpdateHttpError({ reason: error.reason })),
          }),
        ),
      )
      .handleRaw("asset", ({ params }) =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.andThen(service.asset(params)),
          Effect.map(({ asset, stream }) =>
            HttpServerResponse.stream(stream, {
              contentType: "application/octet-stream",
              headers: {
                "content-length": String(asset.size),
                "content-disposition": `attachment; filename="${asset.name}"`,
                "cache-control": "private, no-store",
                "x-content-type-options": "nosniff",
                "x-content-sha256": asset.sha256,
              },
            }),
          ),
          Effect.catchTags({
            AndroidAppUpdateFailure: (error) =>
              Effect.fail(new AndroidAppUpdateHttpError({ reason: error.reason })),
          }),
        ),
      );
  }),
);
