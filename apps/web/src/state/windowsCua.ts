import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcSubscriptionAtomFamily,
  environmentSessionGenerationAtom,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";

const noSession = Atom.make(0);
// A new connection must receive its own status before it can report input released.
const state = Atom.family((key: string) => {
  const [environmentId] = JSON.parse(key) as [EnvironmentId, number];
  return createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: `environment-data:windows-cua:state:${key}`,
    tag: WS_METHODS.windowsCuaSubscribe,
    idleTtlMs: 0,
  })({ environmentId, input: { environmentId } });
});

export function useWindowsCuaStatus(environmentId: EnvironmentId | null) {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const generation = useAtomValue(
    environmentId === null
      ? noSession
      : environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
  );
  const query = useEnvironmentQuery(
    environmentId !== null && presentation?.connection.phase === "connected"
      ? state(JSON.stringify([environmentId, generation]))
      : null,
  );
  return { ...query, data: query.isSuccess && !query.isPending ? query.data : null };
}
