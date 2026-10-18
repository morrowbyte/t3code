import type { OrchestrationV2AppThreadLineage, ScopedThreadRef } from "@t3tools/contracts";
import { deriveAgentIdentity } from "@t3tools/client-runtime/state/agent-identity";
import { memo } from "react";
import { Pressable, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useResolveClassNames } from "uniwind";
import { useThreadShell } from "../../state/entities";
import { useAgentIdentityTheme } from "./useAgentIdentityTheme";

const ACCENTS = ["#0ea5e9", "#f59e0b", "#10b981", "#8b5cf6", "#f43f5e", "#06b6d4"] as const;

export const AgentIdentityLabel = memo(function AgentIdentityLabel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly lineage?: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent"> | null;
  readonly featureTitle?: string | null;
  readonly details?: boolean;
}) {
  const thread = useThreadShell(props.threadRef);
  const { theme } = useAgentIdentityTheme();
  const neutral = useResolveClassNames("text-foreground-muted");
  const identity = deriveAgentIdentity(props.threadRef, thread?.lineage ?? props.lineage, theme);
  const color = theme === "weasel" ? ACCENTS[identity.accent] : neutral.color;
  const content = (
    <View className="min-w-0 flex-row items-center gap-1.5 py-0.5">
      <Svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {identity.icon === "weasel" ? (
          <>
            <Path d="M5 9C1 2 9 2 9 6M15 6c0-4 8-4 4 3M5 9c0 8 4 12 7 12s7-4 7-12c-3-4-11-4-14 0Z" />
            <Path d="m10 15 2 2 2-2M8 11h.01M16 11h.01" />
          </>
        ) : (
          <>
            <Rect x={4} y={7} width={16} height={13} rx={3} />
            <Path d="M12 3v4M2 12h2m16 0h2M8 12h.01M16 12h.01M9 16h6" />
          </>
        )}
      </Svg>
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {identity.label}
      </Text>
    </View>
  );
  if (!props.details) return content;
  return (
    <Pressable
      className="min-h-11 justify-center"
      accessibilityRole="button"
      accessibilityLabel={`Agent details, ${identity.label}`}
      onPress={() =>
        Dialog.alert(
          identity.name,
          [
            identity.role,
            props.featureTitle ?? thread?.title,
            `Display reference: ${identity.discriminator}`,
            `Environment: ${props.threadRef.environmentId}`,
            `Thread: ${props.threadRef.threadId}`,
            thread?.modelSelection
              ? `Provider: ${thread.modelSelection.instanceId} / ${thread.modelSelection.model}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        )
      }
    >
      {content}
    </Pressable>
  );
});
