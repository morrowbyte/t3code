import { VoiceRecordingSettings } from "../components/settings/VoiceRecordingSettings";
import { createFileRoute } from "@tanstack/react-router";
import { VoiceTranscriptionSettingsPanel } from "../components/settings/VoiceTranscriptionSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function VoiceSettingsRoute() {
  return (
    <SettingsPageContainer>
      <VoiceTranscriptionSettingsPanel />
      <VoiceRecordingSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/voice")({ component: VoiceSettingsRoute });
