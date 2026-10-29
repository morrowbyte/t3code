import {
  AgentIdentityTheme as AgentIdentityThemeSchema,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AgentIdentityTheme } from "@t3tools/client-runtime/state/agent-identity";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useEnvironmentSettings } from "~/hooks/useSettings";

export function useAgentIdentityTheme(threadRef: ScopedThreadRef) {
  const [legacyTheme] = useLocalStorage<AgentIdentityTheme, AgentIdentityTheme>(
    "t3code:agent-identity-theme",
    "neutral",
    AgentIdentityThemeSchema,
  );
  const settings = useEnvironmentSettings(threadRef.environmentId);
  return [
    settings.agentIdentityTheme ?? legacyTheme,
    settings.agentIdentityNames[threadRef.threadId],
  ] as const;
}
