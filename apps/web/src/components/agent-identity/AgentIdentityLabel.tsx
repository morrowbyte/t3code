import type { OrchestrationV2AppThreadLineage, ScopedThreadRef } from "@t3tools/contracts";
import {
  deriveAgentIdentity,
  resolveAgentProjectColor,
} from "@t3tools/client-runtime/state/agent-identity";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useAgentIdentityTheme } from "./useAgentIdentityTheme";
import { AgentAvatar } from "./AgentAvatar";

export function AgentIdentityLabel({
  threadRef,
  featureTitle,
  lineage,
}: {
  threadRef: ScopedThreadRef;
  featureTitle?: string | null;
  lineage?: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent">;
}) {
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread ? { environmentId: threadRef.environmentId, projectId: thread.projectId } : null,
  );
  const [theme] = useAgentIdentityTheme();
  const identity = deriveAgentIdentity(threadRef, thread?.lineage ?? lineage, theme);
  const provenance = [
    identity.label,
    featureTitle ?? thread?.title,
    `Display reference: ${identity.discriminator}`,
    `Environment: ${threadRef.environmentId}`,
    `Thread: ${threadRef.threadId}`,
    thread?.modelSelection
      ? `Provider: ${thread.modelSelection.instanceId} / ${thread.modelSelection.model}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 align-bottom"
            style={{ flexWrap: "nowrap" }}
            data-agent-identity={identity.key}
          />
        }
      >
        <AgentAvatar
          threadRef={threadRef}
          theme={theme}
          identity={identity}
          projectColor={resolveAgentProjectColor(project)}
        />
        <span className="min-w-0 truncate">{identity.name}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <span className="whitespace-pre-line">{provenance}</span>
      </TooltipPopup>
    </Tooltip>
  );
}
