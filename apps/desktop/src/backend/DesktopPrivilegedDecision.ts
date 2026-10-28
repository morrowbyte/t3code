// @effect-diagnostics globalFetch:off -- Explicit redirect rejection protects the bootstrap credential at this native HTTP boundary.
import { NodeSocket } from "@effect/platform-node";
import { credentialConnectionId } from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as Catalog,
} from "@t3tools/client-runtime/platform";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  WsRpcGroup,
  type DesktopPrivilegedDecision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import * as Schema from "effect/Schema";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const decodeConnectionCatalog = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

export class DesktopPrivilegedDecisionError extends Schema.TaggedError<DesktopPrivilegedDecisionError>()(
  "DesktopPrivilegedDecisionError",
  { message: Schema.String },
) {}

// Fetch runs in main, outside Chromium's cross-site cookie rules. No credential is
// returned to the renderer. Each exchange uses a newly issued one-time grant.
export async function createApprovalCookie(
  base: URL,
  bearer: string,
  environmentId: string,
): Promise<string> {
  const descriptorResponse = await fetch(new URL("/.well-known/t3/environment", base), {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!descriptorResponse.ok) throw new Error("Target environment unavailable.");
  const descriptor: unknown = await descriptorResponse.json();
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    !("environmentId" in descriptor) ||
    descriptor.environmentId !== environmentId
  ) {
    throw new Error("Target environment mismatch.");
  }
  const grantResponse = await fetch(new URL("/api/auth/pairing-token", base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] }),
  });
  if (!grantResponse.ok) throw new Error("Approval grant unavailable.");
  const grant: unknown = await grantResponse.json();
  if (
    !grant ||
    typeof grant !== "object" ||
    !("credential" in grant) ||
    typeof grant.credential !== "string" ||
    !grant.credential
  )
    throw new Error("Approval grant invalid.");
  const response = await fetch(new URL("/api/auth/browser-session", base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: grant.credential }),
  });
  if (!response.ok) throw new Error("Browser session unavailable.");
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .find((value) => value && /^t3_session_[^=]+=[^;=]+/.test(value));
  if (!cookie) throw new Error("Browser session cookie missing.");
  return cookie;
}

export type SavedApprovalRoute =
  | {
      readonly kind: "bearer";
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly token: string;
    }
  | {
      readonly kind: "ssh";
      readonly target: import("@t3tools/contracts").DesktopSshEnvironmentTarget;
      readonly token: string;
    }
  | { readonly kind: "unsupported"; readonly message: string };

export function selectLocalApprovalRoute(
  routes: readonly { environmentId: string; backendId: string; httpBaseUrl: string }[],
  credentials: Catalog["credentials"],
  environmentId: string,
): { httpBaseUrl: string; token: string } | null {
  const matching = routes.filter((route) => route.environmentId === environmentId);
  if (matching.length !== 1) return null;
  const route = matching[0]!;
  const credential = credentials.find(
    (item) => item.connectionId === `local:${route.backendId}`,
  )?.credential;
  if (!credential || credential._tag !== "BearerConnectionCredential" || !credential.token)
    return null;
  return { httpBaseUrl: route.httpBaseUrl, token: credential.token };
}

/** Select only an enabled, saved route for the requested environment. */
export function selectSavedApprovalRoute(
  catalog: Catalog,
  environmentId: string,
): SavedApprovalRoute | null {
  const targets = catalog.targets.filter((target) => target.environmentId === environmentId);
  if (targets.length === 0) return null;
  if (
    catalog.disabledEnvironmentIds.includes(
      environmentId as Catalog["disabledEnvironmentIds"][number],
    )
  )
    return { kind: "unsupported", message: "The saved target environment is disabled." };
  let reason = "No supported authenticated route is saved for this environment.";
  for (const target of targets) {
    if (target._tag === "RelayConnectionTarget") {
      reason =
        "T3 Connect approval requires the renderer-bound DPoP signer; this route is not yet supported by the desktop approval transport.";
      continue;
    }
    const profile = catalog.profiles.find(
      (item) => item.connectionId === target.connectionId && item.environmentId === environmentId,
    );
    if (!profile) {
      reason = "The saved route profile does not match the target environment.";
      continue;
    }
    if (profile._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect") {
      reason =
        "The saved T3 Connect route requires the renderer-bound DPoP signer; this route is not yet supported by the desktop approval transport.";
      continue;
    }
    const credentialId = credentialConnectionId(target.connectionId);
    const credential = catalog.credentials.find(
      (item) => item.connectionId === credentialId,
    )?.credential;
    if (!credential || credential._tag !== "BearerConnectionCredential" || !credential.token) {
      reason = "The saved route has no authenticated bearer session.";
      continue;
    }
    if (target._tag === "BearerConnectionTarget" && profile._tag === "BearerConnectionProfile") {
      return {
        kind: "bearer",
        httpBaseUrl: profile.httpBaseUrl,
        wsBaseUrl: profile.wsBaseUrl,
        token: credential.token,
      };
    }
    if (target._tag === "SshConnectionTarget" && profile._tag === "SshConnectionProfile") {
      return { kind: "ssh", target: profile.target, token: credential.token };
    }
    reason = "The saved route and profile have incompatible types.";
  }
  return { kind: "unsupported", message: reason };
}

/** Cookie must never be sent to a different host than the session endpoint. */
export function approvalSocketUrl(httpBaseUrl: string, wsBaseUrl: string): URL {
  const http = new URL(httpBaseUrl);
  const ws = new URL(wsBaseUrl);
  if (
    !["http:", "https:"].includes(http.protocol) ||
    ws.protocol !== (http.protocol === "https:" ? "wss:" : "ws:") ||
    ws.host !== http.host ||
    http.username ||
    http.password ||
    ws.username ||
    ws.password
  ) {
    throw new Error("The saved HTTP and WebSocket routes do not share a safe origin.");
  }
  if (ws.pathname === "" || ws.pathname === "/") ws.pathname = "/ws";
  ws.search = "";
  ws.hash = "";
  ws.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  return ws;
}

/** Only the primary local backend is supported. */
export const respond = Effect.fn("desktop.privilegedDecision.respond")(function* (
  input: DesktopPrivilegedDecision,
) {
  const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const stored = yield* catalogStore.get.pipe(
    Effect.mapError(
      () =>
        new DesktopPrivilegedDecisionError({
          message: "The saved connection catalog could not be read.",
        }),
    ),
  );
  const catalog = Option.isNone(stored)
    ? null
    : yield* decodeConnectionCatalog(stored.value).pipe(
        Effect.mapError(
          () =>
            new DesktopPrivilegedDecisionError({
              message: "The saved connection catalog is invalid.",
            }),
        ),
      );
  const route = catalog === null ? null : selectSavedApprovalRoute(catalog, input.environmentId);
  if (route?.kind === "unsupported")
    return yield* new DesktopPrivilegedDecisionError({ message: route.message });
  let httpBaseUrl: string;
  let wsBaseUrl: string;
  let bearer: string;
  if (route?.kind === "bearer") {
    httpBaseUrl = route.httpBaseUrl;
    wsBaseUrl = route.wsBaseUrl;
    bearer = route.token;
  } else if (route?.kind === "ssh") {
    const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    const bootstrap = yield* ssh.ensureEnvironment(route.target, { issuePairingToken: false }).pipe(
      Effect.mapError(
        () =>
          new DesktopPrivilegedDecisionError({
            message: "The saved SSH route could not be connected.",
          }),
      ),
    );
    httpBaseUrl = bootstrap.httpBaseUrl;
    wsBaseUrl = bootstrap.wsBaseUrl;
    bearer = route.token;
  } else {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instances = yield* pool.list;
    const candidates = yield* Effect.all(
      instances.map((instance) =>
        instance.currentConfig.pipe(Effect.map((config) => ({ instance, config }))),
      ),
    );
    const routes = yield* Effect.promise(() =>
      Promise.all(
        candidates.map(async ({ instance, config }) => {
          if (Option.isNone(config)) return null;
          try {
            const base = config.value.httpBaseUrl;
            const response = await fetch(new URL("/.well-known/t3/environment", base), {
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) return null;
            const descriptor: unknown = await response.json();
            if (
              !descriptor ||
              typeof descriptor !== "object" ||
              !("environmentId" in descriptor) ||
              typeof descriptor.environmentId !== "string"
            )
              return null;
            return {
              environmentId: descriptor.environmentId,
              backendId: instance.id,
              httpBaseUrl: base.href,
            };
          } catch {
            return null;
          }
        }),
      ),
    );
    const available = routes.filter((item): item is NonNullable<typeof item> => item !== null);
    const matching = available.filter((item) => item.environmentId === input.environmentId);
    if (matching.length !== 1)
      return yield* new DesktopPrivilegedDecisionError({
        message: "No saved route or local backend is available for this environment.",
      });
    const selected = matching[0]!;
    const primary = yield* pool.primary;
    if (selected.backendId === primary.id) {
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
      bearer = yield* auth.getBearerToken.pipe(
        Effect.mapError(
          () =>
            new DesktopPrivilegedDecisionError({
              message: "Local desktop authentication is unavailable.",
            }),
        ),
      );
      httpBaseUrl = selected.httpBaseUrl;
    } else {
      const localRoute = selectLocalApprovalRoute(
        available,
        catalog?.credentials ?? [],
        input.environmentId,
      );
      if (localRoute === null)
        return yield* new DesktopPrivilegedDecisionError({
          message: "The local target has no authenticated session.",
        });
      httpBaseUrl = localRoute.httpBaseUrl;
      bearer = localRoute.token;
    }
    const ws = new URL(httpBaseUrl);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    wsBaseUrl = ws.href;
  }
  const socketUrl = yield* Effect.try({
    try: () => approvalSocketUrl(httpBaseUrl, wsBaseUrl),
    catch: () =>
      new DesktopPrivilegedDecisionError({
        message: "The saved HTTP and WebSocket routes do not share a safe origin.",
      }),
  });
  const crypto = yield* Crypto.Crypto;
  const cookie = yield* Effect.tryPromise({
    try: () => createApprovalCookie(new URL(httpBaseUrl), bearer, input.environmentId),
    catch: (cause) =>
      new DesktopPrivilegedDecisionError({
        message:
          cause instanceof Error &&
          [
            "Target environment unavailable.",
            "Target environment mismatch.",
            "Approval grant unavailable.",
            "Approval grant invalid.",
            "Browser session unavailable.",
            "Browser session cookie missing.",
          ].includes(cause.message)
            ? cause.message
            : "The target approval session could not be established.",
      }),
  });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          }),
        ).pipe(
          Layer.provide(
            Socket.layerWebSocket(socketUrl.href, { headers: { cookie } }).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructorWS),
            ),
          ),
          Layer.provide(RpcSerialization.layerJson),
        ),
      );
      const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(context));
      const projection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId: input.threadId,
      });
      const request = projection.runtimeRequests.find((item) => item.id === input.requestId);
      if (
        !request?.privilegedCommand ||
        request.status !== "pending" ||
        request.privilegedCommand.state !== "pending" ||
        request.privilegedCommand.packageHash !== input.packageHash ||
        request.privilegedCommand.bundle.environmentId !== input.environmentId ||
        request.privilegedCommand.bundle.threadId !== input.threadId
      ) {
        return yield* new DesktopPrivilegedDecisionError({
          message: "Privileged request is no longer pending or does not match.",
        });
      }
      const commandId = CommandId.make(yield* crypto.randomUUIDv4());
      yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "runtime-request.respond",
        commandId,
        threadId: input.threadId,
        requestId: input.requestId,
        packageHash: input.packageHash,
        decision: input.decision,
      });
    }),
  ).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError(
      () =>
        new DesktopPrivilegedDecisionError({
          message:
            "Desktop approval failed or its outcome is unknown; check the request before retrying.",
        }),
    ),
  );
});
