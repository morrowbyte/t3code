import * as Schema from "effect/Schema";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import type { AgentIdentityTheme } from "@t3tools/client-runtime/state/agent-identity";

const AgentIdentityThemeSchema = Schema.Literals(["neutral", "weasel"]);

export function useAgentIdentityTheme() {
  return useLocalStorage<AgentIdentityTheme, AgentIdentityTheme>(
    "t3code:agent-identity-theme",
    "neutral",
    AgentIdentityThemeSchema,
  );
}
