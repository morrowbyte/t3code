import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { answerCostPresentation } from "@t3tools/client-runtime/answer-cost";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

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
  const snapshot = projectedItem.answerCost ?? support.providerTurn?.cost;
  if (onlyBound && snapshot?.answerItemId !== projectedItem.sourceItemId) return null;
  const cost = answerCostPresentation(
    support.providerTurn,
    projectedItem.sourceItemId,
    projectedItem.answerCost,
  );
  if (!cost) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost-muted" size="xs" aria-label={`API cost: ${cost.label}`} />}
      >
        {cost.label}
      </PopoverTrigger>
      <PopoverPopup width="md" className="max-w-[calc(100vw-2rem)]">
        <p className="whitespace-pre-line text-xs leading-relaxed">{cost.detail}</p>
      </PopoverPopup>
    </Popover>
  );
}
