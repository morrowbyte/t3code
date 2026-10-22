import { useState } from "react";
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
};

export function AgentAvatar({
  identity,
  projectColor,
}: {
  identity: ReturnType<typeof deriveAgentIdentity>;
  projectColor: string;
}) {
  const portraits = PORTRAITS[identity.icon];
  const src = portraits[identity.avatarVariant] ?? portraits[0];
  const [failedSrc, setFailedSrc] = useState<string>();
  return (
    <span
      className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-muted text-3xs text-muted-foreground"
      style={{ borderColor: projectColor, flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {failedSrc === src ? (
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
          onError={() => setFailedSrc(src)}
        />
      )}
    </span>
  );
}
