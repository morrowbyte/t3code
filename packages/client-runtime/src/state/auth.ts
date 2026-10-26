import type {
  AuthGrantScope,
  AuthSessionId,
  AuthAccessSnapshot,
  AuthAccessStreamEvent,
  AuthAccessStreamSnapshotEvent,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import {
  createEnvironmentPairingCredential,
  revokeEnvironmentPairingLink,
  revokeEnvironmentClient,
  revokeOtherEnvironmentClients,
  type AuthAccessHttpContext,
} from "./authAccessHttp.ts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export const EMPTY_AUTH_ACCESS_SNAPSHOT: AuthAccessSnapshot = {
  pairingLinks: [],
  clientSessions: [],
};

function upsertByKey<A>(
  values: ReadonlyArray<A>,
  next: A,
  key: (value: A) => string,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function applyAuthAccessStreamEvent(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): AuthAccessSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "pairingLinkUpserted":
      return {
        ...current,
        pairingLinks: upsertByKey(current.pairingLinks, event.payload, (value) => value.id),
      };
    case "pairingLinkRemoved":
      return {
        ...current,
        pairingLinks: current.pairingLinks.filter((value) => value.id !== event.payload.id),
      };
    case "clientUpserted":
      return {
        ...current,
        clientSessions: upsertByKey(
          current.clientSessions,
          event.payload,
          (value) => value.sessionId,
        ),
      };
    case "clientRemoved":
      return {
        ...current,
        clientSessions: current.clientSessions.filter(
          (value) => value.sessionId !== event.payload.sessionId,
        ),
      };
  }
}

function projectAuthAccessSnapshot(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): readonly [AuthAccessSnapshot, ReadonlyArray<AuthAccessStreamEvent>] {
  const snapshot = applyAuthAccessStreamEvent(current, event);
  const projected: AuthAccessStreamSnapshotEvent = {
    version: 1,
    revision: event.revision,
    type: "snapshot",
    payload: snapshot,
  };
  return [snapshot, [projected]];
}

function withAuthAccessConnection<A, E>(
  request: (context: AuthAccessHttpContext) => Effect.Effect<A, E, HttpClient.HttpClient>,
) {
  return Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    const client = yield* Effect.serviceOption(HttpClient.HttpClient);
    if (Option.isNone(prepared) || Option.isNone(client)) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId: supervisor.target.environmentId,
        message: `${supervisor.target.label} is not connected.`,
      });
    }
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return yield* request({ prepared: prepared.value, signer, remoteAuthorization }).pipe(
      Effect.provideService(HttpClient.HttpClient, client.value),
    );
  });
}

export function createAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    createPairing: createEnvironmentCommand(runtime, {
      label: "environment-auth:create-pairing",
      execute: (input: {
        readonly label?: string;
        readonly scopes?: ReadonlyArray<AuthGrantScope>;
      }) =>
        withAuthAccessConnection((context) => createEnvironmentPairingCredential(context, input)),
    }),
    revokePairing: createEnvironmentCommand(runtime, {
      label: "environment-auth:revoke-pairing",
      execute: (id: string) =>
        withAuthAccessConnection((context) => revokeEnvironmentPairingLink(context, id)),
    }),
    revokeClient: createEnvironmentCommand(runtime, {
      label: "environment-auth:revoke-client",
      execute: (sessionId: AuthSessionId) =>
        withAuthAccessConnection((context) => revokeEnvironmentClient(context, sessionId)),
    }),
    revokeOtherClients: createEnvironmentCommand(runtime, {
      label: "environment-auth:revoke-other-clients",
      execute: (_input: null) => withAuthAccessConnection(revokeOtherEnvironmentClients),
    }),
    accessChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:auth-access-changes",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
          Stream.mapAccum(() => EMPTY_AUTH_ACCESS_SNAPSHOT, projectAuthAccessSnapshot),
        ),
    }),
  };
}
