import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";

import { View } from "react-native";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SettingsSection } from "./components/SettingsSection";
import { useAgentIdentityTheme } from "../agent-identity/useAgentIdentityTheme";

export function SettingsAppearanceRouteScreen() {
  const insets = useSafeAreaInsets();
  const identity = useAgentIdentityTheme();

  return (
    <SettingsScreen title="Appearance">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ThemeAppearanceSection />
        <SettingsSection title="Agent identity">
          <View className="p-3">
            <SegmentedControl
              options={
                [
                  { value: "neutral", label: "Neutral" },
                  { value: "weasel", label: "Helferwiesel" },
                ] as const
              }
              selected={identity.theme}
              onSelect={(value) => {
                if (identity.ready) identity.setTheme(value);
              }}
            />
          </View>
        </SettingsSection>
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
      </ScrollView>
    </SettingsScreen>
  );
}
