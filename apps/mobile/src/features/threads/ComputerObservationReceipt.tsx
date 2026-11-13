import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import {
  computerObservationLabel,
  isNativeObservationTool,
  resolveComputerObservationItem,
} from "@t3tools/client-runtime/work-log/computer-observation-receipt";
import {
  computerInputReceiptLabel,
  isNativeInputTool,
} from "@t3tools/client-runtime/work-log/computer-input-receipt";
import { AppText as Text } from "../../components/ui/AppText";
import { useTurnItemDetail } from "../../state/queries";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}

export function ComputerObservationReceipt(props: Props) {
  const item = props.projectedItem.item;
  return item.type === "dynamic_tool" &&
    (isNativeObservationTool(item.toolName) || isNativeInputTool(item.toolName)) ? (
    <NativeReceipt {...props} />
  ) : null;
}

function NativeReceipt({ environmentId, projectedItem }: Props) {
  const wire = projectedItem.item;
  const detail = useTurnItemDetail(
    wire.type === "dynamic_tool" &&
      (wire.status === "completed" ||
        (isNativeInputTool(wire.toolName) &&
          ["failed", "cancelled", "interrupted"].includes(wire.status))) &&
      wire.outputOmitted
      ? { environmentId, row: projectedItem }
      : null,
  );
  const item = resolveComputerObservationItem(wire, detail.data?.item, Boolean(detail.error));
  const label =
    item.type === "dynamic_tool"
      ? (computerObservationLabel(item) ?? computerInputReceiptLabel(item))
      : null;
  return label === null ? null : (
    <Text accessibilityLiveRegion="polite" className="ml-7 py-1 text-xs text-foreground-muted">
      {label}
    </Text>
  );
}
