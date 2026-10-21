import { createFileRoute } from "@tanstack/react-router";
import { VoiceTranscriptionSettingsPanel } from "../components/settings/VoiceTranscriptionSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function VoiceSettingsRoute() {
  return (
    <SettingsPageContainer>
      <VoiceTranscriptionSettingsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/voice")({ component: VoiceSettingsRoute });
