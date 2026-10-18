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
  if (item.type !== "dynamic_tool") return null;
  const send = readAgentSend(item);
  return (
    <AgentMessage
      messageId={String(projected.id)}
      attribution="agent"
      direction="outgoing"
      environmentId={props.environmentId}
      senderThreadId={send.targetThreadId ? ThreadId.make(send.targetThreadId) : undefined}
      timestampLabel={props.timestampLabel}
      text={send.text ?? ""}
      streaming={item.status === "running"}
      deliveryLabel={
        send.failed
          ? "Sendung fehlgeschlagen"
          : send.accepted
            ? "Sendung angenommen"
            : "Sendestatus offen"
      }
    >
      {(text) =>
        send.text === null ? (
          <Text className="text-sm text-foreground-muted">
            {detail.error ? "Original konnte nicht geladen werden." : "Original wird geladen…"}
          </Text>
        ) : (
          props.children(text)
        )
      }
    </AgentMessage>
  );
});
