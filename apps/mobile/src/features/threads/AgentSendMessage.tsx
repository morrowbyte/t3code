import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { turnItemNeedsDetailFetch } from "@t3tools/client-runtime/work-log/item-detail";
import { memo, type ReactNode } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { useTurnItemDetail } from "../../state/queries";
import { AgentReplyReference } from "./AgentReplyReference";
import { AgentMessage } from "./AgentMessage";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { delegatedTaskStatus } from "@t3tools/client-runtime/state/subagent-display";
import { environmentThreadDetails } from "../../state/threads";
import { agentDelegationText, readAgentSend } from "./agent-message-presentation";

export const AgentSendMessage = memo(function AgentSendMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly row: OrchestrationV2ProjectedTurnItem;
  readonly timestampLabel: string;
  readonly technicalDetails?: ReactNode;
  readonly children: (text: string) => ReactNode;
}) {
  const projected = props.row.item;
  const needsDetail =
    turnItemNeedsDetailFetch(projected) ||
    (projected.type === "subagent" &&
      projected.delegationMessage !== undefined &&
      agentDelegationText(projected) === null);
  const detail = useTurnItemDetail(
    needsDetail ? { environmentId: props.environmentId, row: props.row } : null,
  );
  const fetchedItem = detail.data?.item;
  const item =
    fetchedItem?.type === projected.type && fetchedItem.id === projected.id
      ? fetchedItem
      : projected;
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
  const text = item.type === "subagent" ? agentDelegationText(item) : (send?.text ?? null);
  const remoteChild =
    item.type === "subagent" ? (liveTask?.remoteChild ?? item.remoteChild) : undefined;
  const localChildThreadId =
    item.type === "subagent" ? (liveTask?.childThreadId ?? item.childThreadId) : null;
  const targetThreadId =
    item.type === "subagent"
      ? (localChildThreadId ?? remoteChild?.threadId)
      : send?.targetScope !== "unknown" && send?.targetThreadId
        ? ThreadId.make(send.targetThreadId)
        : undefined;
  const targetEnvironmentId = localChildThreadId
    ? props.environmentId
    : (remoteChild?.environmentId ??
      (send?.targetEnvironmentId
        ? EnvironmentId.make(send.targetEnvironmentId)
        : props.environmentId));
  const deliveryLabel = delegation
    ? item.type === "subagent"
      ? delegatedTaskStatus(liveTask ?? item).label
      : "Sendestatus offen"
    : send?.failed
      ? "Sendung fehlgeschlagen"
      : send?.accepted
        ? "Sendung angenommen"
        : "Sendestatus offen";
  return (
    <AgentMessage
      messageId={String(projected.id)}
      attribution="agent"
      direction="outgoing"
      environmentId={props.environmentId}
      senderThreadId={targetThreadId}
      senderEnvironmentId={targetEnvironmentId}
      timestampLabel={props.timestampLabel}
      text={text ?? ""}
      previewText={delegation?.firstParagraph}
      technicalDetails={props.technicalDetails}
      attachments={send?.replyTo ? <AgentReplyReference reply={send.replyTo} /> : undefined}
      streaming={!delegation && item.status === "running"}
      deliveryLabel={`${deliveryLabel}${send?.targetScope === "unknown" ? " · Zielumgebung unbekannt" : ""}`}
    >
      {(bodyText) =>
        text === null ? (
          <Text className="text-sm text-foreground-muted">
            {detail.error
              ? "Original konnte nicht geladen werden."
              : needsDetail && detail.isPending
                ? "Original wird geladen…"
                : "Original nicht verfügbar."}
          </Text>
        ) : (
          props.children(bodyText)
        )
      }
    </AgentMessage>
  );
});
