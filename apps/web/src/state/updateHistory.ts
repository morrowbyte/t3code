import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const hostUpdateHistory = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:update-history",
  tag: WS_METHODS.serverGetUpdateHistory,
  staleTimeMs: 0,
  refreshIntervalMs: 5_000,
});
export const deleteHostUpdateHistory = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:delete-update-history",
  tag: WS_METHODS.serverDeleteUpdateHistory,
});
