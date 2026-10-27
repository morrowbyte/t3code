import {
  clientRpcRequiredScopes,
  sessionGrantsScope,
  authScopeRequiredResponse,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import { RpcPermissionGuard } from "./client.ts";

/** Install the usual scope check for a background client without UI atoms. */
export const provideEnvironmentSessionGuard = Effect.fn("EnvironmentSessionGuard.provide")(
  function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const http = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    const authorize = Effect.fn("EnvironmentSessionGuard.authorize")(function* (
      environmentId: EnvironmentId,
      method: string,
      input: unknown,
    ) {
      const scopes = clientRpcRequiredScopes(method, input);
      if (scopes.length === 0) return;
      const unavailable = () =>
        new EnvironmentAuthorizationError({
          ...authScopeRequiredResponse(scopes[0]!),
          message: "This connected environment session is unavailable or lacks permission.",
        });
      const session = yield* registry
        .run(
          environmentId,
          Effect.gen(function* () {
            const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
            const prepared = yield* SubscriptionRef.get(supervisor.prepared);
            if (Option.isNone(prepared)) return yield* unavailable();
            return yield* fetchEnvironmentSessionState({
              prepared: prepared.value,
              signer,
              remoteAuthorization,
            }).pipe(Effect.mapError(unavailable));
          }),
        )
        .pipe(Effect.mapError(unavailable));
      const missing = scopes.find((scope) => !sessionGrantsScope(session, scope));
      if (missing !== undefined)
        return yield* new EnvironmentAuthorizationError({
          ...authScopeRequiredResponse(missing),
          message: `This connection requires ${missing}.`,
        });
    });
    return yield* effect.pipe(
      Effect.provideService(RpcPermissionGuard, {
        authorize: (environmentId, method, input) =>
          authorize(environmentId, method, input).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
          ),
      }),
    );
  },
);
