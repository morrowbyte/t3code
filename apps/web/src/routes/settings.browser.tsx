import { createFileRoute } from "@tanstack/react-router";
import { BrowserSettingsPanel } from "../components/settings/IntegrationsSettings";

export const Route = createFileRoute("/settings/browser")({
  component: BrowserSettingsPanel,
});
