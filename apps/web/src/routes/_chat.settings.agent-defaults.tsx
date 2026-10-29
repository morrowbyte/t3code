import { createFileRoute } from "@tanstack/react-router";
import { AgentDefaultsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/agent-defaults")({
  component: AgentDefaultsSettingsPanel,
});
