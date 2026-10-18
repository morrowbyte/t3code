import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { AgentIdentityTheme } from "@t3tools/client-runtime/state/agent-identity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useAgentIdentityTheme() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences);
  const theme: AgentIdentityTheme =
    ready && preferences.value.agentIdentityTheme === "weasel" ? "weasel" : "neutral";
  return {
    theme,
    ready,
    setTheme: (value: AgentIdentityTheme) => update({ agentIdentityTheme: value }),
  };
}
