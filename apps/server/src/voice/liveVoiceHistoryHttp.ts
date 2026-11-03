import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LiveVoiceHistory from "./LiveVoiceHistory.ts";

const mapError = Effect.fn("liveVoiceHistoryHttp.mapError")(function* (
  error: LiveVoiceHistory.LiveVoiceHistoryError,
) {
  if (error.reason === "not_found") return yield* failEnvironmentNotFound("thread_not_found");
  return yield* failEnvironmentInternal("internal_error");
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "liveVoiceHistory",
  Effect.fnUntraced(function* (handlers) {
    const history = yield* LiveVoiceHistory.LiveVoiceHistory;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const authorizeScope = Effect.fn("liveVoiceHistoryHttp.authorize")(function* (
      scope: AuthEnvironmentScope,
    ) {
      yield* requireEnvironmentScope(scope);
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      );
      return yield* environment.getEnvironmentId;
    });
    const authorize = authorizeScope(AuthOrchestrationReadScope);
    return handlers
      .handle("diagnosticsSettings", ({ payload }) =>
        Effect.gen(function* () {
          yield* authorizeScope(AuthSettingsWriteScope);
          yield* history
            .setDiagnosticsEnabled(payload.diagnosticsEnabled)
            .pipe(Effect.catch(() => failEnvironmentInternal("internal_error")));
          return yield* history.diagnosticsSettings.pipe(
            Effect.catch(() => failEnvironmentInternal("internal_error")),
          );
        }),
      )
      .handle("diagnostics", ({ params, query }) =>
        Effect.gen(function* () {
          const environmentId = yield* authorize;
          return yield* history
            .diagnostics({
              environmentId,
              threadId: params.threadId,
              ...(query.leaseId ? { leaseId: query.leaseId } : {}),
              ...(query.generation ? { generation: Number(query.generation) } : {}),
              ...(query.after ? { after: Number(query.after) } : {}),
              ...(query.limit ? { limit: Number(query.limit) } : {}),
            })
            .pipe(Effect.catch(mapError));
        }),
      )
      .handle("calls", ({ params, query }) =>
        Effect.gen(function* () {
          const environmentId = yield* authorize;
          return yield* history
            .list({
              environmentId,
              threadId: params.threadId,
              ...(query.before ? { before: Number(query.before) } : {}),
            })
            .pipe(Effect.catch(mapError));
        }),
      )
      .handle("transcript", ({ params }) =>
        Effect.gen(function* () {
          const environmentId = yield* authorize;
          return yield* history
            .transcript({
              environmentId,
              threadId: params.threadId,
              leaseId: params.leaseId,
              generation: Number(params.generation),
            })
            .pipe(Effect.catch(mapError));
        }),
      );
  }),
);
