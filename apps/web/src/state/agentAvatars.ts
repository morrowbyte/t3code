import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { WS_METHODS, type ScopedThreadRef, type AgentAvatarKey } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

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

const agentAvatarGenerate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "agent-avatar:generate",
  tag: WS_METHODS.agentAvatarGenerate,
  onSettled: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        readAgentAvatar({
          environmentId: target.environmentId,
          input: { threadId: target.input.threadId, theme: target.input.theme },
        }),
      ),
    ),
});

const agentAvatarCancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "agent-avatar:cancel",
  tag: WS_METHODS.agentAvatarCancel,
  onSettled: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        readAgentAvatar({
          environmentId: target.environmentId,
          input: { threadId: target.input.threadId, theme: target.input.theme },
        }),
      ),
    ),
});

export function useAgentAvatar(threadRef: ScopedThreadRef, theme: AgentAvatarKey["theme"]) {
  const query = readAgentAvatar({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, theme },
  });
  const result = useEnvironmentQuery(pollingReads(query));
  const refresh = useAtomRefresh(query);
  return { ...result, refresh };
}

export function useAgentAvatarActions(threadRef: ScopedThreadRef, theme: AgentAvatarKey["theme"]) {
  const generate = useAtomCommand(agentAvatarGenerate, { reportFailure: false });
  const cancel = useAtomCommand(agentAvatarCancel, { reportFailure: false });
  const canGenerate = useAtomValue(agentAvatarGenerate.permissionAtom(threadRef.environmentId));
  const canCancel = useAtomValue(agentAvatarCancel.permissionAtom(threadRef.environmentId));
  const key = JSON.stringify([threadRef.environmentId, threadRef.threadId, theme]);
  const [operation, setOperation] = useState({ key, pending: false, error: null as string | null });
  const target = {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, theme },
  };

  const run = async (name: string | null, regenerate = false) => {
    if (operation.key === key && operation.pending) return;
    setOperation({ key, pending: true, error: null });
    try {
      const result =
        name === null
          ? await cancel(target)
          : await generate({ ...target, input: { ...target.input, name, regenerate } });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setOperation((current) =>
          current.key === key
            ? {
                key,
                pending: false,
                error: cause instanceof Error ? cause.message : "Avatar-Anfrage fehlgeschlagen.",
              }
            : current,
        );
      } else {
        setOperation((current) =>
          current.key === key ? { key, pending: false, error: null } : current,
        );
      }
    } catch (cause) {
      setOperation((current) =>
        current.key === key
          ? {
              key,
              pending: false,
              error: cause instanceof Error ? cause.message : "Avatar-Anfrage fehlgeschlagen.",
            }
          : current,
      );
    }
  };

  return {
    canGenerate,
    canCancel,
    pending: operation.key === key && operation.pending,
    error: operation.key === key ? operation.error : null,
    generate: (name: string, regenerate: boolean) => run(name, regenerate),
    cancel: () => run(null),
  };
}
