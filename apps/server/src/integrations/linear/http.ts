import {
  AuthSettingsWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ByteSize from "effect/ByteSize";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { requireEnvironmentScope } from "../../auth/http.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "../../scheduledTasks/webhookRoute.ts";
import * as LinearIntegration from "./LinearIntegration.ts";

const settingsLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "linear",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* LinearIntegration.LinearIntegration;
    return handlers
      .handle("linearSettings", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(Effect.andThen(service.settings)),
      )
      .handle("linearAction", ({ payload: { action } }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          if (action.type === "sync" || action.type === "retry")
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (action.type === "bind") yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.action(action);
        }).pipe(Effect.withTracerEnabled(false)),
      );
  }),
);

const ingressLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "linearIngress",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* LinearIntegration.LinearIntegration;
    return handlers
      .handleRaw("linearCallback", ({ query }) =>
        service.callback(query).pipe(
          Effect.as(
            HttpServerResponse.text(
              "Linear connected. Return to T3 Code and reload Linear settings.",
            ),
          ),
          Effect.catch(() =>
            Effect.succeed(
              HttpServerResponse.text("Linear connection failed. Start Connect again in T3 Code.", {
                status: 400,
              }),
            ),
          ),
          Effect.withTracerEnabled(false),
        ),
      )
      .handleRaw("linearEvent", ({ request }) =>
        Effect.gen(function* () {
          if (!(yield* service.settings).enabled) return HttpServerResponse.empty({ status: 404 });
          const length = Number(request.headers["content-length"] ?? 0);
          if (!Number.isFinite(length) || length > WEBHOOK_MAX_BODY_BYTES)
            return HttpServerResponse.empty({ status: 413 });
          const bytes = yield* request.arrayBuffer.pipe(
            Effect.provideService(
              HttpIncomingMessage.MaxBodySize,
              ByteSize.bytes(WEBHOOK_MAX_BODY_BYTES),
            ),
            Effect.option,
          );
          if (Option.isNone(bytes)) return HttpServerResponse.empty({ status: 413 });
          const headers: Record<string, string> = {};
          for (const name of ["linear-signature", "linear-delivery"]) {
            const value = request.headers[name];
            if (value !== undefined) headers[name] = value;
          }
          const outcome = yield* service.receive({ headers, body: new Uint8Array(bytes.value) });
          return HttpServerResponse.jsonUnsafe(
            { outcome },
            {
              status:
                outcome === "disabled"
                  ? 404
                  : outcome === "rejected"
                    ? 401
                    : outcome === "queue_full"
                      ? 429
                      : 200,
            },
          );
        }).pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
          Effect.withTracerEnabled(false),
        ),
      );
  }),
);
export const layer = Layer.mergeAll(settingsLayer, ingressLayer);
