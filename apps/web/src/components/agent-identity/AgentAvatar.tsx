import { useState } from "react";
import type { ScopedThreadRef, AgentAvatarKey } from "@t3tools/contracts";
import { useAgentAvatar } from "~/state/agentAvatars";
import { useAssetUrlState } from "~/assets/assetUrls";
import type { deriveAgentIdentity } from "@t3tools/client-runtime/state/agent-identity";
import neutral0 from "@t3tools/client-runtime/agent-avatars/neutral-0.webp";
import neutral1 from "@t3tools/client-runtime/agent-avatars/neutral-1.webp";
import neutral2 from "@t3tools/client-runtime/agent-avatars/neutral-2.webp";
import neutral3 from "@t3tools/client-runtime/agent-avatars/neutral-3.webp";
import weasel0 from "@t3tools/client-runtime/agent-avatars/weasel-0.webp";
import weasel1 from "@t3tools/client-runtime/agent-avatars/weasel-1.webp";
import weasel2 from "@t3tools/client-runtime/agent-avatars/weasel-2.webp";
import weasel3 from "@t3tools/client-runtime/agent-avatars/weasel-3.webp";

const PORTRAITS = {
  agent: [neutral0, neutral1, neutral2, neutral3],
  weasel: [weasel0, weasel1, weasel2, weasel3],
} as const;

export function AgentAvatar({
  threadRef,
  theme,
  identity,
  projectColor,
}: {
  threadRef: ScopedThreadRef;
  theme: AgentAvatarKey["theme"];
  identity: ReturnType<typeof deriveAgentIdentity>;
  projectColor: string;
}) {
  const portraits = PORTRAITS[identity.icon];
  const avatar = useAgentAvatar(threadRef, theme);
  const asset = useAssetUrlState(
    threadRef.environmentId,
    avatar.data?.attachmentId
      ? { _tag: "attachment", attachmentId: avatar.data.attachmentId }
      : null,
  );
  const savedSrc = asset._tag === "Success" ? asset.url : null;
  const fallbackSrc = portraits[identity.avatarVariant] ?? portraits[0];
  const [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set());
  const src = savedSrc && !failedSources.has(savedSrc) ? savedSrc : fallbackSrc;
  return (
    <span
      className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-muted text-3xs text-muted-foreground"
      style={{ borderColor: projectColor, flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {failedSources.has(src) ? (
        identity.name
          .split(" ")
          .map((word) => word[0])
          .join("")
      ) : (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailedSources((current) => new Set(current).add(src))}
        />
      )}
    </span>
  );
}
