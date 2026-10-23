import { useEffect, useState } from "react";
import {
  AuthSettingsWriteScope,
  type VoiceRecordingEntry,
  type VoiceRecordingSettings as RecordingSettings,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  recordingSettingsRequest,
  listCallRecordings,
  downloadCallRecording,
} from "../../voice/voiceRecordingClient";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";

export function VoiceRecordingSettings() {
  const { scope, target } = useSettingsScope();
  const environmentId =
    scope.kind === "environment" && target?.environmentId === scope.environmentId
      ? scope.environmentId
      : undefined;
  return (
    <SettingsSection id="call-recording" title="Call recordings">
      {environmentId ? (
        <RecordingHost
          key={environmentId}
          environmentId={environmentId}
          label={target?.label ?? "Selected host"}
        />
      ) : (
        <p role="status" className="px-4 py-3 text-xs text-muted-foreground">
          Select an environment to view its call recordings.
        </p>
      )}
    </SettingsSection>
  );
}
function RecordingHost({ environmentId, label }: { environmentId: EnvironmentId; label: string }) {
  const [settings, setSettings] = useState<typeof RecordingSettings.Type | null>(null);
  const [entries, setEntries] = useState<ReadonlyArray<typeof VoiceRecordingEntry.Type>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const prepared = usePreparedConnection(environmentId);
  const [settingsConnection, setSettingsConnection] = useState(prepared);
  if (settingsConnection !== prepared) {
    setSettingsConnection(prepared);
    setSettings(null);
    setEntries([]);
    setError("");
  }
  useEffect(() => {
    if (prepared._tag === "None") return;
    let active = true;
    void Promise.all([recordingSettingsRequest(environmentId), listCallRecordings(environmentId)])
      .then(([value, recordings]) => {
        if (active) {
          setSettings(value);
          setEntries(recordings);
        }
      })
      .catch(() => {
        if (active)
          setError("Could not read recordings on this host. Reconnect or update the environment.");
      });
    return () => {
      active = false;
    };
  }, [environmentId, prepared]);
  async function change(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      setSettings(await recordingSettingsRequest(environmentId, enabled));
    } catch {
      setError("Could not change recording permission on this host.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SettingsRow
        title="Record calls on this host"
        description={`${label} · This signed-in session · Keep 3 days`}
        control={
          <Switch
            aria-label="Record calls on this host"
            checked={settings?.enabled === true}
            disabled={!settings || !editable || busy}
            onCheckedChange={(enabled) => void change(enabled)}
          />
        }
      />
      {settings ? (
        <div className="space-y-2 px-4 py-3 text-xs text-muted-foreground">
          <div className="wrap-anywhere">{settings.directory}</div>
          <div>
            {settings.enabled ? "On for new calls · User and agent saved separately" : "Off"}
          </div>
        </div>
      ) : null}
      {entries.length ? (
        <ul className="space-y-3 px-4 py-3">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span>
                {new Date(entry.startedAt).toLocaleString()} ·{" "}
                {entry.endedAt !== null ? "Saved" : "Partial / in progress"}
              </span>
              {(["user", "assistant"] as const).map((role) => (
                <Button
                  key={role}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void downloadCallRecording(environmentId, entry, role).catch(() =>
                      setError("This track could not be downloaded."),
                    );
                  }}
                >
                  {role === "user" ? "User audio" : "Agent audio"}
                </Button>
              ))}
            </li>
          ))}
        </ul>
      ) : settings ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          No recorded calls for this session.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
