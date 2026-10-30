import { useAtomRefresh } from "@effect/atom-react";
import { WS_METHODS, type ScopedThreadRef, type AgentAvatarKey } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const readAgentAvatar = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "agent-avatar:read",
  tag: WS_METHODS.agentAvatarRead,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});

const pollingReads = Atom.family((query: ReturnType<typeof readAgentAvatar>) =>
  Atom.make((get) => {
    const result = get(query);
    // One shared timer per query; idle labels and failed reads never keep polling.
    if (result._tag === "Success" && !result.waiting && result.value.status === "generating") {
      const timer = setTimeout(() => get.refresh(query), 2_000);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return result;
  }),
);

export const agentAvatarRead = (target: Parameters<typeof readAgentAvatar>[0]) =>
  pollingReads(readAgentAvatar(target));

export function useAgentAvatar(threadRef: ScopedThreadRef, theme: AgentAvatarKey["theme"]) {
  const query = readAgentAvatar({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, theme },
  });
  const result = useEnvironmentQuery(pollingReads(query));
  const refresh = useAtomRefresh(query);
  return { ...result, refresh };
}
