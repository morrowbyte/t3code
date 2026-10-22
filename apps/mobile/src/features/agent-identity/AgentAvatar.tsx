import type { ScopedThreadRef, AgentAvatarKey } from "@t3tools/contracts";
import { useAgentAvatar } from "../../state/agentAvatars";
import { useAssetUrl } from "../../state/assets";
import { assetImageSource } from "../../lib/assetImageSource";
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
  threadRef,
  theme,
  identity,
  projectColor,
  size = "sm",
}: {
  readonly threadRef: ScopedThreadRef;
  readonly theme: AgentAvatarKey["theme"];
  readonly identity: ReturnType<typeof deriveAgentIdentity>;
  readonly projectColor: string;
  readonly size?: "sm" | "md";
}) {
  const portraits = PORTRAITS[identity.icon];
  const avatar = useAgentAvatar(threadRef, theme);
  const resource = avatar.data?.attachmentId
    ? { _tag: "attachment" as const, attachmentId: avatar.data.attachmentId }
    : null;
  const url = useAssetUrl(threadRef.environmentId, resource);
  const fallbackSource = portraits[identity.avatarVariant] ?? portraits[0];
  const [failedSources, setFailedSources] = useState<ReadonlySet<string | number>>(() => new Set());
  const sourceKey = url && !failedSources.has(url) ? url : fallbackSource;
  const source =
    typeof sourceKey === "string" && resource
      ? assetImageSource(threadRef.environmentId, resource, sourceKey)
      : fallbackSource;
  return (
    <View
      className="items-center justify-center overflow-hidden bg-grouped-card"
      style={{
        width: size === "md" ? 32 : 24,
        height: size === "md" ? 32 : 24,
        borderRadius: 16,
        borderWidth: 2,
        borderColor: projectColor,
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {failedSources.has(sourceKey) ? (
        <AppText className="text-3xs text-foreground-muted" allowFontScaling={false}>
          {identity.name
            .split(" ")
            .map((word) => word[0])
            .join("")}
        </AppText>
      ) : (
        <Image
          source={source}
          style={{ width: size === "md" ? 28 : 20, height: size === "md" ? 28 : 20 }}
          contentFit="cover"
          onError={() => setFailedSources((current) => new Set(current).add(sourceKey))}
        />
      )}
    </View>
  );
}
