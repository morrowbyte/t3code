import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import type { deriveAgentIdentity } from "@t3tools/client-runtime/state/agent-identity";

import { AppText } from "../../components/ui/AppText";

const PORTRAITS = {
  agent: [
    require("@t3tools/client-runtime/agent-avatars/neutral-0.webp"),
    require("@t3tools/client-runtime/agent-avatars/neutral-1.webp"),
    require("@t3tools/client-runtime/agent-avatars/neutral-2.webp"),
    require("@t3tools/client-runtime/agent-avatars/neutral-3.webp"),
  ],
  weasel: [
    require("@t3tools/client-runtime/agent-avatars/weasel-0.webp"),
    require("@t3tools/client-runtime/agent-avatars/weasel-1.webp"),
    require("@t3tools/client-runtime/agent-avatars/weasel-2.webp"),
    require("@t3tools/client-runtime/agent-avatars/weasel-3.webp"),
  ],
} as const;

export function AgentAvatar({
  identity,
  projectColor,
}: {
  readonly identity: ReturnType<typeof deriveAgentIdentity>;
  readonly projectColor: string;
}) {
  const portraits = PORTRAITS[identity.icon];
  const source: number = portraits[identity.avatarVariant] ?? portraits[0];
  const [failedSource, setFailedSource] = useState<number>();
  return (
    <View
      className="items-center justify-center overflow-hidden bg-grouped-card"
      style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: projectColor }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {failedSource === source ? (
        <AppText className="text-3xs text-foreground-muted" allowFontScaling={false}>
          {identity.name
            .split(" ")
            .map((word) => word[0])
            .join("")}
        </AppText>
      ) : (
        <Image
          source={source}
          style={{ width: 20, height: 20 }}
          contentFit="cover"
          onError={() => setFailedSource(source)}
        />
      )}
    </View>
  );
}
