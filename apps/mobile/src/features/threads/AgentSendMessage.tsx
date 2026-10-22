import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { turnItemNeedsDetailFetch } from "@t3tools/client-runtime/work-log/item-detail";
import { memo, type ReactNode } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { useTurnItemDetail } from "../../state/queries";
import { AgentMessage } from "./AgentMessage";
import { readAgentSend } from "./agent-message-presentation";

export const AgentSendMessage = memo(function AgentSendMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly row: OrchestrationV2ProjectedTurnItem;
  readonly timestampLabel: string;
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
  if (item.type !== "dynamic_tool" && !delegation) return null;
  const send = item.type === "dynamic_tool" ? readAgentSend(item) : null;
  const text = delegation?.firstParagraph ?? send?.text ?? null;
  const targetThreadId =
    item.type === "subagent"
      ? (item.childThreadId ?? undefined)
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
      timestampLabel={props.timestampLabel}
      text={text ?? ""}
      previewText={delegation?.firstParagraph}
      streaming={!delegation && item.status === "running"}
      deliveryLabel={
        delegation
          ? "Auftrag erteilt"
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
