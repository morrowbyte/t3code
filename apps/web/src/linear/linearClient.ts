import { LinearIntegrationError, type EnvironmentId, type LinearAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AtomRegistry } from "effect/reactivity";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import { requestEnvironmentLinear } from "@t3tools/client-runtime/state/linear";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

export async function linearRequest(environmentId: EnvironmentId, action?: LinearAction) {
  const request = connectionAtomRuntime.fn<void>()((_input, get) =>
    Effect.gen(function* () {
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (Option.isNone(prepared) || prepared.value.environmentId !== environmentId)
        return yield* new LinearIntegrationError({ reason: "offline" });
      return yield* requestEnvironmentLinear({
        prepared: prepared.value,
        signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
        remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
        ...(action ? { action } : {}),
      });
    }).pipe(Effect.withTracerEnabled(false)),
  );
  appAtomRegistry.set(request, undefined);
  const result = await Effect.runPromise(
    Effect.result(AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true })),
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

export function linearErrorMessage(error: unknown): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined;
  switch (reason) {
    case "disabled":
      return "Enable Linear first.";
    case "oauth_unconfigured":
      return "A Linear OAuth app must be registered for this environment before Connect is available.";
    case "not_connected":
    case "revoked":
      return "Reconnect Linear for this environment.";
    case "target_unavailable":
      return "The selected thread is unavailable.";
    case "offline":
      return "Linear is unavailable. The delivery is kept for an explicit retry.";
    default:
      return "Could not update Linear on this environment. Check its connection and permissions.";
  }
}
