import * as Schema from "effect/Schema";
import { useId } from "react";
import {
  AGENT_IDENTITY_THEMES,
  AGENT_IDENTITY_THEME_OPTIONS,
  AgentIdentityTheme,
} from "@t3tools/contracts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";

const isAgentIdentityTheme = Schema.is(AgentIdentityTheme);

export function AgentIdentitySettings() {
  const id = useId();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const { targets } = useSettingsScope();
  const themeMixed = useScopedSettingsMixed(["agentIdentityTheme"]);
  const personalityMixed = useScopedSettingsMixed(["agentPersonalityEnabled"]);
  const anyPersonalityEnabled = personalityMixed || settings.agentPersonalityEnabled;
  const [legacyTheme] = useLocalStorage<AgentIdentityTheme, AgentIdentityTheme>(
    "t3code:agent-identity-theme",
    "neutral",
    AgentIdentityTheme,
  );
  const theme = settings.agentIdentityTheme ?? legacyTheme;
  const canWrite =
    writeAllowed && targets.length > 0 && targets.every((target) => target.projectId === null);
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <h3 id={`${id}-heading`} className="text-sm font-medium">
        Agent identity
      </h3>
      <div className="max-w-64">
        <Select
          value={themeMixed ? null : theme}
          disabled={!canWrite}
          onValueChange={(value) => {
            if (isAgentIdentityTheme(value)) updateSettings({ agentIdentityTheme: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Agent identity style">
            <SelectValue>{themeMixed ? "Mixed" : AGENT_IDENTITY_THEMES[theme].label}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {AGENT_IDENTITY_THEME_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-personality`}>Personality in agent messages</label>
        <Switch
          id={`${id}-personality`}
          checked={anyPersonalityEnabled}
          mixed={personalityMixed}
          disabled={!canWrite || (themeMixed && !anyPersonalityEnabled)}
          onCheckedChange={(enabled) => {
            if (!canWrite || (enabled && themeMixed)) return;
            updateSettings(
              enabled
                ? { agentPersonalityEnabled: true, agentIdentityTheme: theme }
                : { agentPersonalityEnabled: false },
            );
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {personalityMixed ? "Mixed. " : ""}For selected environments. New agent context uses this
        preference.
      </p>
    </section>
  );
}
