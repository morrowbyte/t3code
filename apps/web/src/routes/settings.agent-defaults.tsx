import { createFileRoute } from "@tanstack/react-router";
import { AgentDefaultsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/agent-defaults")({
  component: AgentDefaultsSettingsPanel,
});
