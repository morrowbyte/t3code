import {
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const modes = [
  { value: "sidebar", label: "Sidebar threads (1–9)" },
  { value: "pinned-tabs", label: "Pinned work tabs (1–8)" },
] as const;

const labelModes = [
  { value: "agent-name", label: "Agent name" },
  { value: "thread-title", label: "Thread title" },
] as const;

export function WorkTabNavigationSetting() {
  const mode = useClientSettings((settings) => settings.numericNavigationMode);
  const labelMode = useClientSettings((settings) => settings.workTabLabelMode);
  const hydrated = useClientSettingsHydrated();
  return (
    <SettingsSection title="Work tabs">
      <SettingsRow
        title="Number shortcuts"
        description="Ctrl/Command + number. In pinned mode, 9 does not open a sidebar thread."
        control={
          <Select
            items={modes}
            value={mode}
            disabled={!hydrated}
            onValueChange={(value) => {
              if (value) void updateClientSettings({ numericNavigationMode: value });
            }}
          >
            <SelectTrigger aria-label="Number shortcuts">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {modes.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Tab labels"
        control={
          <Select
            items={labelModes}
            value={labelMode}
            disabled={!hydrated}
            onValueChange={(value) => {
              if (value) void updateClientSettings({ workTabLabelMode: value });
            }}
          >
            <SelectTrigger aria-label="Tab labels">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {labelModes.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
