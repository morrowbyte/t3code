import { useEffect, useRef, useState } from "react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type VoiceTranscriptionSettings,
} from "@t3tools/contracts";
import { voiceSettingsRequest, voiceSettingsErrorMessage } from "../../voice/voiceSettingsClient";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { Switch } from "../ui/switch";

export function VoiceDiagnosticsSettings() {
  const { scope, target } = useSettingsScope();
  const environmentId =
    scope.kind === "environment" && target?.environmentId === scope.environmentId
      ? scope.environmentId
      : undefined;
  if (!environmentId) return null;
  return <DiagnosticsHost key={environmentId} environmentId={environmentId} />;
}

function DiagnosticsHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [settings, setSettings] = useState<typeof VoiceTranscriptionSettings.Type | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generationRef = useRef(0);
  const prepared = usePreparedConnection(environmentId);
  const editable = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const [connection, setConnection] = useState(prepared);
  if (connection !== prepared) {
    setConnection(prepared);
    setSettings(null);
    setBusy(false);
    setError("");
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reloads the selected connection's diagnostic preference and ignores replies from a disconnected host.
  useEffect(() => {
    const generation = ++generationRef.current;
    if (prepared._tag === "None") return;
    void voiceSettingsRequest(environmentId)
      .then((value) => {
        if (generationRef.current === generation) setSettings(value);
      })
      .catch((cause: unknown) => {
        if (generationRef.current === generation) setError(voiceSettingsErrorMessage(cause));
      });
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [environmentId, prepared]);

  async function change(enabled: boolean) {
    if (!settings || !editable || busy) return;
    const generation = generationRef.current;
    setBusy(true);
    setError("");
    await voiceSettingsRequest(environmentId, { diagnosticsEnabled: enabled })
      .then((value) => {
        if (generationRef.current === generation) setSettings(value);
      })
      .catch((cause: unknown) => {
        if (generationRef.current === generation) setError(voiceSettingsErrorMessage(cause));
      })
      .finally(() => {
        if (generationRef.current === generation) setBusy(false);
      });
  }

  return (
    <SettingsSection id="voice-diagnostics" title="Voice diagnostics">
      <SettingsRow
        title="Capture diagnostic events"
        description="Timing and delivery metadata · Kept for 24 hours · No audio"
        control={
          <Switch
            aria-label="Capture voice diagnostic events"
            checked={settings?.diagnosticsEnabled === true}
            disabled={!settings || !editable || busy}
            onCheckedChange={(enabled) => void change(enabled)}
          />
        }
      />
      {error ? (
        <p role="alert" className="px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
