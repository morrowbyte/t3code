import { useEffect, useState } from "react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { androidApkNative } from "../../native/AndroidApkUpdates";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { createAndroidApkTransport } from "./android-apk-transport";
import { createAndroidApkUpdater, type AndroidApkUpdater } from "./android-apk-update";

export function AndroidApkUpdatePanel(props: { readonly updater: AndroidApkUpdater }) {
  const [state, setState] = useState(props.updater.getState);
  const [showNotes, setShowNotes] = useState(false);
  useEffect(() => props.updater.subscribe(setState), [props.updater]);
  const busy = ["checking", "downloading", "verifying", "installing"].includes(state.phase);
  const percent = state.release ? Math.floor((state.bytes / state.release.apk.size) * 100) : 0;
  return (
    <>
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Check for Android update"
        disabled={busy}
        loading={state.phase === "checking"}
        onPress={() => void props.updater.check()}
      />
      {state.installed ? (
        <Text className="px-4 py-2 text-sm text-foreground-muted">
          Installed {state.installed.versionName}
        </Text>
      ) : null}
      {state.phase === "current" ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-2 text-foreground">
          Up to date
        </Text>
      ) : null}
      {state.release ? (
        <View>
          <SettingsActionRow
            label={`What's new in ${state.release.version}`}
            onPress={() => setShowNotes((current) => !current)}
          />
          {showNotes ? (
            <Text selectable className="px-4 pb-4 text-base text-foreground">
              {state.release.changelog}
            </Text>
          ) : null}
          {["available", "cancelled"].includes(state.phase) ? (
            <SettingsActionRow
              icon="arrow.down.circle"
              label="Download APK"
              detail={`${(state.release.apk.size / 1024 / 1024).toFixed(1)} MB`}
              onPress={() => void props.updater.download()}
            />
          ) : null}
        </View>
      ) : null}
      {state.phase === "downloading" ? (
        <Text
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: percent }}
          accessibilityLiveRegion="polite"
          className="px-4 py-2 text-foreground"
        >
          Downloading… {percent}% · {(state.bytes / 1024 / 1024).toFixed(1)} MB
        </Text>
      ) : null}
      {state.phase === "verifying" ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-2 text-foreground">
          Verifying APK…
        </Text>
      ) : null}
      {["checking", "downloading", "verifying"].includes(state.phase) ? (
        <SettingsActionRow label="Cancel update" onPress={props.updater.cancel} />
      ) : null}
      {["ready", "permission-required", "installer-opened"].includes(state.phase) ? (
        <SettingsActionRow
          label={
            state.phase === "installer-opened"
              ? "Open Android installer again"
              : "Open Android installer"
          }
          onPress={() => void props.updater.install()}
        />
      ) : null}
      {state.phase === "permission-required" ? (
        <>
          <Text className="px-4 py-2 text-foreground-muted">
            Allow Morrowbyte to request app installs in Android settings, then return here.
          </Text>
          <SettingsActionRow
            label="Allow app installs"
            onPress={() => void props.updater.permission()}
          />
        </>
      ) : null}
      {state.phase === "installer-opened" ? (
        <Text className="px-4 py-2 text-foreground-muted">Android installation dialog opened.</Text>
      ) : null}
      {state.error ? (
        <>
          <Text accessibilityRole="alert" className="px-4 py-2 text-danger-foreground">
            {state.error}
          </Text>
          <SettingsActionRow
            label="Retry update"
            disabled={busy}
            onPress={() => void props.updater.retry()}
          />
        </>
      ) : null}
    </>
  );
}

function ConnectedAndroidApkUpdate(props: { readonly environmentId: EnvironmentId }) {
  const [updater] = useState(() =>
    createAndroidApkUpdater(createAndroidApkTransport(props.environmentId), androidApkNative),
  );
  useEffect(
    () => () => {
      void updater.dispose();
    },
    [updater],
  );
  return <AndroidApkUpdatePanel updater={updater} />;
}

export function AndroidApkUpdateSection() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const host =
    selectedTargets.find((entry) => entry.environmentId === selectedId) ?? selectedTargets[0];
  return (
    <SettingsSection title="Android updates">
      <Menu
        actions={selectedTargets.map((entry) => ({ id: entry.environmentId, title: entry.label }))}
        onPressAction={({ nativeEvent }) => {
          const next = selectedTargets.find((entry) => entry.environmentId === nativeEvent.event);
          if (next) setSelectedId(next.environmentId);
        }}
      >
        <SettingsActionRow
          label="Update host"
          detail={host?.label ?? "No connected host"}
          disabled={selectedTargets.length < 2}
          onPress={() => {}}
        />
      </Menu>
      {host ? (
        <ConnectedAndroidApkUpdate key={host.environmentId} environmentId={host.environmentId} />
      ) : null}
    </SettingsSection>
  );
}
