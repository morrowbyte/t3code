import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_IDENTITY_THEMES,
  AGENT_IDENTITY_THEME_OPTIONS,
  AgentIdentityTheme,
  AuthSettingsWriteScope,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentsWithScope } from "../../state/session";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { resolveMobileSettingsTargets } from "../settings/settings-scoped-server";
import { useSettingsWriter } from "../settings/useSettingsWriter";

const isAgentIdentityTheme = Schema.is(AgentIdentityTheme);

export function AgentIdentitySettings() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const writeSettings = useSettingsWriter();
  const [pending, setPending] = useState(false);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const legacyTheme = AsyncResult.isSuccess(preferences)
    ? (preferences.value.agentIdentityTheme ?? "neutral")
    : "neutral";
  const settings = selectedTargets[0]?.serverConfig.settings;
  const theme = settings?.agentIdentityTheme ?? legacyTheme;
  const themeMixed = selectedTargets.some(
    (target) => (target.serverConfig.settings.agentIdentityTheme ?? legacyTheme) !== theme,
  );
  const personality = settings?.agentPersonalityEnabled ?? false;
  const personalityMixed = selectedTargets.some(
    (target) => target.serverConfig.settings.agentPersonalityEnabled !== personality,
  );
  const anyPersonalityEnabled = personalityMixed || personality;
  const disabled =
    !ready ||
    pending ||
    selectedProjectKey !== null ||
    selectedTargets.length === 0 ||
    selectedTargets.some((target) => !writable.has(target.environmentId));
  const save = async (patch: ServerSettingsPatch) => {
    if (disabled) return;
    setPending(true);
    await writeSettings(
      resolveMobileSettingsTargets(selectedTargets, null),
      selectedTargets.map((target) => ({ environmentId: target.environmentId, patch })),
    ).finally(() => {
      setPending(false);
    });
  };
  return (
    <SettingsSection title="Agent identity">
      <Menu
        title="Agent identity"
        actions={AGENT_IDENTITY_THEME_OPTIONS.map((option) => ({
          id: option.value,
          title: option.label,
          state: !themeMixed && theme === option.value ? ("on" as const) : ("off" as const),
          attributes: { disabled },
        }))}
        onPressAction={({ nativeEvent }) => {
          if (isAgentIdentityTheme(nativeEvent.event)) {
            void save({ agentIdentityTheme: nativeEvent.event });
          }
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            "Agent identity style, " + (themeMixed ? "Mixed" : AGENT_IDENTITY_THEMES[theme].label)
          }
          accessibilityState={{ disabled }}
          disabled={disabled}
          className="min-h-12 justify-center px-4 py-3"
        >
          <AppText>{themeMixed ? "Mixed" : AGENT_IDENTITY_THEMES[theme].label}</AppText>
        </Pressable>
      </Menu>
      <SettingsSwitchRow
        label="Personality in agent messages"
        subtitle={
          personalityMixed
            ? "Mixed. Switch off for all selected environments."
            : "New agent context uses this preference."
        }
        value={anyPersonalityEnabled}
        disabled={disabled || (themeMixed && !anyPersonalityEnabled)}
        onValueChange={(enabled) => {
          if (enabled && themeMixed) return;
          void save(
            enabled
              ? { agentPersonalityEnabled: true, agentIdentityTheme: theme }
              : { agentPersonalityEnabled: false },
          );
        }}
      />
    </SettingsSection>
  );
}
