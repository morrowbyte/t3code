import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const state = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:windows-cua:state",
  tag: WS_METHODS.windowsCuaSubscribe,
});

export function useWindowsCuaStatus(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : state({
          environmentId,
          input: { environmentId },
        }),
  );
}
