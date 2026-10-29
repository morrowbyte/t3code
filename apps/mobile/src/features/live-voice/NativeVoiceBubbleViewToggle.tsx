import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { AppText } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";

export function useNativeVoiceBubbleView() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences);
  return {
    enabled: ready && preferences.value.voiceBubblesExperimental === true,
    ready,
    setEnabled: (enabled: boolean) => update({ voiceBubblesExperimental: enabled }),
  };
}

export function NativeVoiceBubbleViewToggle() {
  const { enabled, ready, setEnabled } = useNativeVoiceBubbleView();
  return (
    <View className="flex-row flex-wrap items-center gap-2 py-2">
      <ThemedSwitch
        accessibilityLabel="Sprechblasen · Experimentell"
        accessibilityHint="Ausgeschaltet wird der bisherige Gesprächsverlauf angezeigt."
        value={enabled}
        disabled={!ready}
        onValueChange={setEnabled}
      />
      <View className="min-w-0 flex-1">
        <AppText className="text-xs text-foreground-muted">Sprechblasen · Experimentell</AppText>
        <AppText className="text-xs text-foreground-muted">
          {enabled ? "Ein" : "Aus · Bisheriger Verlauf"}
        </AppText>
      </View>
    </View>
  );
}
