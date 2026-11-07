import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { useTurnItemDetail } from "../../state/queries";
import type { TurnItemSource } from "./timelineRowContext";
import { computerObservationReceipt, isNativeObservationTool } from "./computerObservationReceipt";

interface Props {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly source?: TurnItemSource | undefined;
}

export function ComputerObservationReceipt(props: Props) {
  const item = props.projectedItem.item;
  return item.type === "dynamic_tool" && isNativeObservationTool(item.toolName) ? (
    <NativeObservationReceipt {...props} />
  ) : null;
}

function NativeObservationReceipt({ projectedItem, environmentId, source }: Props) {
  const wire = projectedItem.item;
  const fetches = wire.type === "dynamic_tool" && wire.status === "completed" && wire.outputOmitted;
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
  const fetched = detail.data?.item;
  const item =
    fetches &&
    wire.type === "dynamic_tool" &&
    !detail.error &&
    fetched?.type === "dynamic_tool" &&
    fetched.toolName === wire.toolName &&
    fetched.id === wire.id &&
    fetched.threadId === wire.threadId &&
    turnItemDetailRevision(fetched) === turnItemDetailRevision(wire)
      ? fetched
      : wire;
  const receipt = item.type === "dynamic_tool" ? computerObservationReceipt(item) : null;
  if (!receipt) return null;
  const label =
    receipt.kind === "unconfirmed"
      ? "Observation policy unconfirmed for this call"
      : receipt.mode === "disabled"
        ? "Observation disabled at this call"
        : receipt.active
          ? "Observation allowed · reading at this call"
          : "Observation allowed · idle at this call";
  return <p className="ms-7 py-1 text-xs text-muted-foreground">{label}</p>;
}
