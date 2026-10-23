import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpEffect from "effect/http/HttpEffect";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as VoiceRecordingService from "./VoiceRecordingService.ts";

const privateResponse = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "private, no-store")),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voiceRecording",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* VoiceRecordingService.VoiceRecordingService;
    return handlers
      .handle("settings", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.flatMap(service.settings),
          Effect.tap(() => privateResponse),
        ),
      )
      .handle("updateSettings", ({ payload }) =>
        requireEnvironmentScope(AuthSettingsWriteScope).pipe(
          Effect.flatMap((session) => service.updateSettings(session, payload.enabled)),
        ),
      )
      .handle("start", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.flatMap((session) => service.start(session, payload)),
        ),
      )
      .handle("append", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.flatMap((session) => service.append(session, payload)),
        ),
      )
      .handle("finish", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.flatMap((session) => service.finish(session, payload.id)),
        ),
      )
      .handle("list", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.flatMap(service.list),
          Effect.tap(() => privateResponse),
        ),
      )
      .handleRaw("file", ({ params }) =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.flatMap((session) => service.file(session, params.id, params.role)),
          Effect.map(({ stream, mimeType, filename }) =>
            HttpServerResponse.stream(stream, {
              contentType: mimeType,
              headers: {
                "content-disposition": `attachment; filename="${filename}"`,
                "cache-control": "private, no-store",
                "x-content-type-options": "nosniff",
              },
            }),
          ),
        ),
      );
  }),
);
