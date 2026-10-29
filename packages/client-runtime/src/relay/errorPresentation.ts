import type { DpopFailureReason } from "@t3tools/contracts";
import {
  T3CHAT_PLAN_TUNNEL_LIMITS,
  type RelayEnvironmentStatusResponse,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";

export const DPOP_CLOCK_HINT = "Enable automatic date and time on both devices, then retry.";

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
export const DPOP_UNKNOWN_HINT =
  "Retry. If it still fails, check automatic date and time on both devices; their clocks may differ.";

export const DPOP_RETRY_HINT = "Retry. If it still fails, copy the trace ID.";

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return DPOP_CLOCK_HINT;
  if (reason === undefined) return DPOP_UNKNOWN_HINT;
  return DPOP_RETRY_HINT;
}

export function dpopFailureMessage(message: string, reason: DpopFailureReason | undefined): string {
  return `${message} ${dpopFailureHint(reason)}`;
}

export function relayProtectedErrorMessage(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return "Relay rejected the cloud session token.";
        case "invalid_dpop":
          return dpopFailureMessage("Relay rejected the DPoP proof.", error.dpopFailureReason);
        case "not_authorized":
          return "Relay rejected the authenticated request.";
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return "Relay rejected an expired environment link proof.";
    case "RelayEnvironmentLinkProofInvalidError":
      return `Relay rejected the environment link proof (${error.reason}).`;
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link does not read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return "No active T3 Connect link. Link this environment again on its host.";
      }
      if (error.reason === "managed_endpoint_allocation_not_ready") {
        return "T3 Connect tunnel starting.";
      }
      if (error.reason === "endpoint_provider_not_managed") {
        return "Activity-only link; connections unavailable. On the host, enable T3 Connect in Settings > Sharing & access.";
      }
      return error.reason
        ? `Relay rejected the environment connection request (${error.reason}).`
        : "Relay rejected the environment connection request.";
    case "RelayEnvironmentEndpointUnavailableError":
      return `Relay could not reach the environment endpoint (${error.reason}).`;
    case "RelayEnvironmentEndpointTimedOutError":
      return "Relay timed out while contacting the environment endpoint.";
    case "RelayEnvironmentLinkFailedError":
      return `Relay could not link the environment (${error.reason}).`;
    case "RelayEnvironmentLinkUnavailableError":
      return `Relay cannot provision the managed endpoint (${error.reason}).${
        error.provisioningStage ? ` Failed stage: ${error.provisioningStage}.` : ""
      }`;
    case "RelayEnvironmentLinkLimitExceededError":
      return error.maxTunnels < T3CHAT_PLAN_TUNNEL_LIMITS.premier
        ? `Tunnel limit reached (${error.maxTunnels}). Unlink an environment or link a paid T3 Chat account in T3 Connect account settings on web or desktop. Limits: Pro ${T3CHAT_PLAN_TUNNEL_LIMITS.pro}, Premier ${T3CHAT_PLAN_TUNNEL_LIMITS.premier}.`
        : `Tunnel limit reached (${error.maxTunnels}). Unlink an environment to free one.`;
    case "RelayAgentActivityPublishProofExpiredError":
      return "Relay rejected an expired agent activity publish proof.";
    case "RelayAgentActivityPublishProofInvalidError":
      return `Relay rejected the agent activity publish proof (${error.reason}).`;
    case "RelayInternalError":
      return `Relay encountered an internal error (${error.reason}).`;
  }
}

// The relay cuts off a request it cannot finish in time with a 504 that no
// endpoint declares, so the client sees only the status.
export const RELAY_GATEWAY_TIMEOUT_MESSAGE =
  "Relay timeout (HTTP 504). Retry in a few minutes. If it still fails, report the trace ID.";

export function relayRequestFailureDetail(error: {
  readonly relayError?: RelayProtectedError | undefined;
  readonly status?: number | undefined;
}): string | null {
  if (error.relayError) return relayProtectedErrorMessage(error.relayError);
  if (error.status === 504) return RELAY_GATEWAY_TIMEOUT_MESSAGE;
  if (error.status !== undefined) return `Relay returned an unexpected HTTP ${error.status}.`;
  return null;
}

const RELAY_TUNNEL_RELEASED_MESSAGE =
  "T3 Connect tunnel removed after inactivity. Start and update T3 Code on that host to reconnect.";

export function relayOfflineReasonMessage(
  status: Pick<RelayEnvironmentStatusResponse, "offlineReason">,
): string | null {
  switch (status.offlineReason) {
    case "tunnel_released":
      return RELAY_TUNNEL_RELEASED_MESSAGE;
    case undefined:
      return null;
  }
}
