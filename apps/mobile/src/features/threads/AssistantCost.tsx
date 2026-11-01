import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { answerCostPresentation } from "@t3tools/client-runtime/answer-cost";
import { Pressable } from "react-native";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useV2ItemSupport } from "../../state/v2-item-support";

export function AssistantCost({
  environmentId,
  projectedItem,
  onlyBound = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly onlyBound?: boolean;
}) {
  const support = useV2ItemSupport({
    environmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  if (onlyBound && support.providerTurn?.cost?.answerItemId !== projectedItem.sourceItemId)
    return null;
  const cost = answerCostPresentation(support.providerTurn, projectedItem.sourceItemId);
  if (!cost) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`API cost: ${cost.label}`}
      hitSlop={8}
      onPress={() => Dialog.alert(cost.label, cost.detail)}
      className="min-h-11 justify-center px-1"
    >
      <AppText className="text-xs tabular-nums text-foreground-muted">{cost.label}</AppText>
    </Pressable>
  );
}
