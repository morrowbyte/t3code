import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { turnItemNeedsDetailFetch } from "@t3tools/client-runtime/work-log/item-detail";
import { memo, type ReactNode } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { useTurnItemDetail } from "../../state/queries";
import { AgentMessage } from "./AgentMessage";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { delegatedTaskStatus } from "@t3tools/client-runtime/state/subagent-display";
import { environmentThreadDetails } from "../../state/threads";
import { readAgentSend } from "./agent-message-presentation";

export const AgentSendMessage = memo(function AgentSendMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly row: OrchestrationV2ProjectedTurnItem;
  readonly timestampLabel: string;
  readonly technicalDetails?: ReactNode;
  readonly children: (text: string) => ReactNode;
}) {
  const projected = props.row.item;
  const detail = useTurnItemDetail(
    turnItemNeedsDetailFetch(projected)
      ? { environmentId: props.environmentId, row: props.row }
      : null,
  );
  const item = detail.data?.item ?? projected;
  const delegation = item.type === "subagent" ? item.delegationMessage : undefined;
  const liveTask = useAtomValue(
    environmentThreadDetails.threadAtom(
      scopeThreadRef(props.environmentId, props.row.sourceThreadId),
    ),
    (thread) =>
      item.type === "subagent"
        ? (thread?.projection.subagents.find((agent) => agent.id === item.subagentId) ?? null)
        : null,
  );
  if (item.type !== "dynamic_tool" && !delegation) return null;
  const send = item.type === "dynamic_tool" ? readAgentSend(item) : null;
  const text = delegation?.firstParagraph ?? send?.text ?? null;
  const remoteChild =
    item.type === "subagent" ? (liveTask?.remoteChild ?? item.remoteChild) : undefined;
  const localChildThreadId =
    item.type === "subagent" ? (liveTask?.childThreadId ?? item.childThreadId) : null;
  const targetThreadId =
    item.type === "subagent"
      ? (localChildThreadId ?? remoteChild?.threadId)
      : send?.targetThreadId
        ? ThreadId.make(send.targetThreadId)
        : undefined;
  return (
    <AgentMessage
      messageId={String(projected.id)}
      attribution="agent"
      direction="outgoing"
      environmentId={props.environmentId}
      senderThreadId={targetThreadId}
      senderEnvironmentId={localChildThreadId ? props.environmentId : remoteChild?.environmentId}
      timestampLabel={props.timestampLabel}
      text={text ?? ""}
      previewText={delegation?.firstParagraph}
      technicalDetails={props.technicalDetails}
      streaming={!delegation && item.status === "running"}
      deliveryLabel={
        delegation
          ? item.type === "subagent"
            ? delegatedTaskStatus(liveTask ?? item).label
            : "Sendestatus offen"
          : send?.failed
            ? "Sendung fehlgeschlagen"
            : send?.accepted
              ? "Sendung angenommen"
              : "Sendestatus offen"
      }
    >
      {(bodyText) =>
        text === null ? (
          <Text className="text-sm text-foreground-muted">
            {detail.error ? "Original konnte nicht geladen werden." : "Original wird geladen…"}
          </Text>
        ) : (
          props.children(bodyText)
        )
      }
    </AgentMessage>
  );
});
