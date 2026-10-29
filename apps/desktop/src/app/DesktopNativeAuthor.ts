import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import {
  NativeAuthorError,
  WS_METHODS,
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_VERSION,
  type NativeAuthorRequest,
  type NativeAuthorState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import * as HttpClient from "effect/http/HttpClient";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";

export class DesktopNativeAuthor extends Context.Service<
  DesktopNativeAuthor,
  {
    readonly execute: (
      request: NativeAuthorRequest,
    ) => Effect.Effect<NativeAuthorState, NativeAuthorError>;
  }
>()("@t3tools/desktop/app/DesktopNativeAuthor") {}

const isNativeAuthorError = Schema.is(NativeAuthorError);
const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;

  const execute = Effect.fn("desktop.nativeAuthor.execute")(function* (
    request: NativeAuthorRequest,
  ) {
    const stage = (phase: string) =>
      process.env.T3CODE_NATIVE_AUTHOR_DIAGNOSTICS === "1"
        ? Effect.logInfo("Native author transport").pipe(
            Effect.annotateLogs({ phase, operation: request.operation }),
          )
        : Effect.void;
    yield* stage("begin");
    const primary = yield* pool.primary;
    const config = yield* primary.currentConfig;
    if (Option.isNone(config)) return yield* new NativeAuthorError({ code: "backend-unavailable" });
    yield* stage("primary-ready");
    const bearerToken = yield* auth.getBearerToken.pipe(
      Effect.mapError(() => new NativeAuthorError({ code: "backend-unavailable" })),
    );
    yield* stage("bearer-ready");
    const httpBaseUrl = config.value.httpBaseUrl.href;
    const ws = new URL(httpBaseUrl);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    ws.pathname = "/ws";
    const socketUrl = new URL(
      yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: ws.href,
        httpBaseUrl,
        bearerToken,
      }).pipe(Effect.mapError(() => new NativeAuthorError({ code: "backend-unavailable" }))),
    );
    socketUrl.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
    yield* stage("ticket-ready");

    // The ticket, bearer and backend URL stay inside this app-owned scope. A lost
    // response never replays a mutation; the caller must reconcile with read.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Keep the socket protocol alive for the request, rather than only
        // for construction of the client that will use it.
        const protocolContext = yield* Layer.build(
          Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolSocket({
              retryTransientErrors: false,
              retryPolicy: Schedule.recurs(0),
            }),
          ).pipe(
            Layer.provide(
              Socket.layerWebSocket(socketUrl.href).pipe(
                Layer.provide(Socket.layerWebSocketConstructorGlobal),
              ),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        );
        const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocolContext));
        yield* stage("rpc-ready");
        return yield* request.operation === "read" || request.operation === "open-results"
          ? client[WS_METHODS.nativeAuthorRead](request)
          : client[WS_METHODS.nativeAuthorWrite](request);
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((error) =>
        isNativeAuthorError(error)
          ? error
          : new NativeAuthorError({
              code:
                request.operation === "read" || request.operation === "open-results"
                  ? "backend-unavailable"
                  : "outcome-unknown",
            }),
      ),
    );
  });
  return DesktopNativeAuthor.of({
    execute: Effect.fn("DesktopNativeAuthor.execute")((request) =>
      execute(request).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    ),
  });
});

export const layer = Layer.effect(DesktopNativeAuthor, make);
