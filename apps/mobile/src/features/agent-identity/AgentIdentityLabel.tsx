import type { OrchestrationV2AppThreadLineage, ScopedThreadRef } from "@t3tools/contracts";
import {
  deriveAgentIdentity,
  resolveAgentProjectColor,
} from "@t3tools/client-runtime/state/agent-identity";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useAgentIdentityTheme } from "./useAgentIdentityTheme";
import { AgentAvatar } from "./AgentAvatar";

export const AgentIdentityLabel = memo(function AgentIdentityLabel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly lineage?: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent"> | null;
  readonly featureTitle?: string | null;
  readonly details?: boolean;
  readonly size?: "sm" | "md";
}) {
  const thread = useQuietThreadShell(props.threadRef);
  const project = useProject(
    thread ? { environmentId: props.threadRef.environmentId, projectId: thread.projectId } : null,
  );
  const { theme } = useAgentIdentityTheme();
  const identity = deriveAgentIdentity(props.threadRef, thread?.lineage ?? props.lineage, theme);
  const content = (
    <View className="min-w-0 flex-row items-center gap-1.5 py-0.5">
      <AgentAvatar
        threadRef={props.threadRef}
        theme={theme}
        identity={identity}
        projectColor={resolveAgentProjectColor(project)}
      />
      <Text
        className={`min-w-0 flex-1 text-foreground-muted ${props.size === "md" ? "text-lg font-t3-medium" : "text-xs"}`}
        numberOfLines={1}
      >
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
