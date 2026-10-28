import { StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppActivityIndicator } from "./ui/AppActivityIndicator";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

import { AppText as Text } from "./ui/AppText";
import { BrandMark } from "./BrandMark";
import { CREW_COLORS } from "../lib/mobileBranding";

export function LoadingScreen(props: {
  readonly message: string;
  readonly embedded?: boolean;
  readonly messagePlacement?: "above-spinner" | "below-spinner";
}) {
  const { themeAppearance: colorScheme } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const messagePlacement = props.messagePlacement ?? "below-spinner";

  return (
    <View
      className="flex-1"
      style={{
        paddingTop: props.embedded ? 0 : insets.top,
        ...(props.embedded ? {} : { backgroundColor: CREW_COLORS.ink }),
      }}
    >
      <StatusBar
        barStyle={!props.embedded || colorScheme === "dark" ? "light-content" : "dark-content"}
      />
      <View className="flex-1 items-center justify-center gap-5 px-6">
        <BrandMark compact onInk={!props.embedded} />
        {messagePlacement === "above-spinner" ? (
          <Text
            className="font-t3-bold text-lg text-foreground"
            style={props.embedded ? undefined : { color: CREW_COLORS.paper }}
          >
            {props.message}
          </Text>
        ) : null}
        <AppActivityIndicator size="large" color={CREW_COLORS.accent} />
        {messagePlacement === "below-spinner" ? (
          <Text
            className="font-t3-bold text-lg text-foreground"
            style={props.embedded ? undefined : { color: CREW_COLORS.paper }}
          >
            {props.message}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
