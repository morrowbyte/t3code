import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
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
    const authorize = Effect.gen(function* () {
      yield* requireEnvironmentScope(AuthOrchestrationReadScope);
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      );
      return yield* environment.getEnvironmentId;
    });
    return handlers
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
