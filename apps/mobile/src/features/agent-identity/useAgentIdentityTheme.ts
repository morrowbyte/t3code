import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { mobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";

export function useAgentIdentityTheme(threadRef: ScopedThreadRef) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(threadRef.environmentId));
  const legacyTheme = AsyncResult.isSuccess(preferences)
    ? (preferences.value.agentIdentityTheme ?? "neutral")
    : "neutral";
  return {
    theme: settings?.agentIdentityTheme ?? legacyTheme,
    manualName: settings?.agentIdentityNames[threadRef.threadId],
  };
}
