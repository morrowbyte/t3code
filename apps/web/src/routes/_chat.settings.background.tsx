import { createFileRoute } from "@tanstack/react-router";
import { BackgroundSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/background")({
  component: BackgroundSettingsPanel,
});
