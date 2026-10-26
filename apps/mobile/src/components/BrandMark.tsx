import Constants from "expo-constants";
import { Image } from "expo-image";
import { View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { CREW_BRAND_MARK_SOURCE } from "./brandAssets";
import { CREW_COLORS, resolveMobileStageLabel } from "../lib/mobileBranding";

const appVariant = Constants.expoConfig?.extra?.appVariant;
const DEFAULT_STAGE_LABEL = resolveMobileStageLabel(appVariant);

export function BrandMark(props: {
  readonly compact?: boolean;
  readonly stageLabel?: string;
  readonly onInk?: boolean;
}) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const stageLabel = props.stageLabel ?? DEFAULT_STAGE_LABEL;

  return (
    <View className="flex-row items-center gap-3">
      <Image
        source={CREW_BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: compact ? 10 : 14,
        }}
      />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="text-lg font-t3-bold tracking-[-0.4px] text-foreground"
            style={props.onInk ? { color: CREW_COLORS.paper } : undefined}
          >
            Crew
          </Text>
          {stageLabel ? (
            <View className="rounded-full bg-subtle px-2 py-1">
              <Text className="text-3xs font-t3-bold tracking-[1.1px] uppercase text-foreground-muted">
                {stageLabel}
              </Text>
            </View>
          ) : null}
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">by Morrowbyte</Text>
        ) : null}
      </View>
    </View>
  );
}
