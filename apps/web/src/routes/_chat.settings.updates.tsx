import { createFileRoute } from "@tanstack/react-router";
import { VersionSettingsSection } from "../components/settings/SettingsPanels";
import { UpdateHistoryPanel } from "../components/settings/UpdateHistoryPanel";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function UpdatesSettingsRoute() {
  return (
    <SettingsPageContainer>
      <VersionSettingsSection />
      <UpdateHistoryPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/updates")({
  component: UpdatesSettingsRoute,
});
