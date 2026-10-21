import { createFileRoute } from "@tanstack/react-router";
import { BackgroundSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/background")({
  component: BackgroundSettingsPanel,
});
