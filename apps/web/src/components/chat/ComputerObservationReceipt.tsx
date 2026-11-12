import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { useTurnItemDetail } from "../../state/queries";
import type { TurnItemSource } from "./timelineRowContext";
import {
  computerObservationLabel,
  isNativeObservationTool,
  resolveComputerObservationItem,
} from "@t3tools/client-runtime/work-log/computer-observation-receipt";
import {
  computerInputReceiptLabel,
  isNativeInputTool,
} from "@t3tools/client-runtime/work-log/computer-input-receipt";

interface Props {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly source?: TurnItemSource | undefined;
}

export function ComputerObservationReceipt(props: Props) {
  const item = props.projectedItem.item;
  return item.type === "dynamic_tool" &&
    (isNativeObservationTool(item.toolName) || isNativeInputTool(item.toolName)) ? (
    <NativeObservationReceipt {...props} />
  ) : null;
}

function NativeObservationReceipt({ projectedItem, environmentId, source }: Props) {
  const wire = projectedItem.item;
  const fetches =
    wire.type === "dynamic_tool" &&
    (wire.status === "completed" ||
      (isNativeInputTool(wire.toolName) &&
        ["failed", "cancelled", "interrupted"].includes(wire.status))) &&
    wire.outputOmitted;
  const detail = useTurnItemDetail(
    fetches
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wire),
        }
      : null,
    source?.detail,
  );
  const item = resolveComputerObservationItem(wire, detail.data?.item, Boolean(detail.error));
  const label =
    item.type === "dynamic_tool"
      ? (computerObservationLabel(item) ?? computerInputReceiptLabel(item))
      : null;
  return label === null ? null : (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="ms-7 py-1 text-xs text-muted-foreground"
    >
      {label}
    </p>
  );
}
