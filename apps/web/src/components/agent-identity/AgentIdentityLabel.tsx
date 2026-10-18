import type { OrchestrationV2AppThreadLineage, ScopedThreadRef } from "@t3tools/contracts";
import { deriveAgentIdentity } from "@t3tools/client-runtime/state/agent-identity";
import { BotIcon } from "lucide-react";
import { useQuietThreadShell } from "~/state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useAgentIdentityTheme } from "./useAgentIdentityTheme";

const ACCENTS = [
  "text-sky-500",
  "text-amber-500",
  "text-emerald-500",
  "text-violet-500",
  "text-rose-500",
  "text-cyan-500",
] as const;

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
            data-agent-identity={identity.key}
          />
        }
      >
        {identity.icon === "weasel" ? (
          <svg
            viewBox="0 0 24 24"
            className={`size-3.5 shrink-0 ${ACCENTS[identity.accent]}`}
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 9C1 2 9 2 9 6M15 6c0-4 8-4 4 3M5 9c0 8 4 12 7 12s7-4 7-12c-3-4-11-4-14 0Z" />
            <path d="m10 15 2 2 2-2M8 11h.01M16 11h.01" />
          </svg>
        ) : (
          <BotIcon className={`size-3.5 shrink-0 ${ACCENTS[identity.accent]}`} aria-hidden />
        )}
        <span className="min-w-0 truncate">{identity.name}</span>
        <span className="shrink-0">· {identity.role}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <span className="whitespace-pre-line">{provenance}</span>
      </TooltipPopup>
    </Tooltip>
  );
}
