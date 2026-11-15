import { createFileRoute } from "@tanstack/react-router";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { VoiceSettingsPanel } from "../components/settings/VoiceSettingsPanel";
import { VoiceTranscriptionSettingsPanel } from "../components/settings/VoiceTranscriptionSettings";
import { VoiceRecordingSettings } from "../components/settings/VoiceRecordingSettings";

function VoiceSettingsRoute() {
  return (
    <>
      <VoiceSettingsPanel />
      <SettingsPageContainer>
        <VoiceTranscriptionSettingsPanel />
        <VoiceRecordingSettings />
      </SettingsPageContainer>
    </>
  );
}

export const Route = createFileRoute("/_chat/settings/voice")({ component: VoiceSettingsRoute });
