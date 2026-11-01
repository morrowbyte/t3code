import type { OrchestrationV2ProviderTurn, TurnCostSnapshot, TurnItemId } from "@t3tools/contracts";

const count = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

function formatAnswerCost(amount: number): string {
  return amount > 0 && amount < 0.001 ? "< $0.001" : `≈ ${money.format(amount)}`;
}

export function answerCostPresentation(
  turn: OrchestrationV2ProviderTurn | null | undefined,
  itemId: TurnItemId,
): { readonly label: string; readonly detail: string } | null {
  if (!turn || turn.status === "pending" || turn.status === "running") return null;
  const cost = turn.cost;
  if (cost?.answerItemId != null && cost.answerItemId !== itemId) return null;
  if (!cost || cost.answerItemId === null) {
    return {
      label: "Cost unavailable",
      detail: "No saved API cost measurement is available for this response.",
    };
  }
  const usage = cost.usage;
  const details = [
    "Main-agent API cost for this provider turn, including tool and reasoning calls.",
    ...(cost.model
      ? [
          `Model: ${cost.model}${cost.reason === "tier_unavailable" ? "" : ` · ${cost.serviceTier === "fast" ? "Priority / Fast" : cost.serviceTier}`}`,
        ]
      : []),
    ...(usage
      ? [
          `Input: ${usage.inputTokens === undefined ? "unknown" : count.format(usage.inputTokens)} tokens · cache read: ${usage.cachedInputTokens === undefined ? "not reported" : count.format(usage.cachedInputTokens)} · cache write: ${usage.cacheCreationTokens === undefined ? "not reported" : count.format(usage.cacheCreationTokens)}`,
          `Output: ${usage.outputTokens === undefined ? "unknown" : count.format(usage.outputTokens)} tokens${usage.reasoningTokens === undefined ? "" : ` · reasoning: ${count.format(usage.reasoningTokens)} (included)`}`,
          ...(usage.hasSubagents ? ["Subagent costs are excluded."] : []),
        ]
      : []),
  ];
  if (cost.status === "unavailable" || cost.amountUsd === undefined) {
    details.push(unavailableReason(cost.reason));
    return { label: "Cost unavailable", detail: details.join("\n") };
  }
  details.push(
    `Estimated from ${cost.source === "custom" ? "custom" : "published"} token rates saved on ${cost.pricedAt.slice(0, 10)}; not an invoice charge.`,
  );
  if (cost.status === "partial")
    details.push("Incomplete token measurement; the actual cost may be higher.");
  return {
    label: `${formatAnswerCost(cost.amountUsd)}${cost.status === "partial" ? " · partial" : ""}`,
    detail: details.join("\n"),
  };
}

function unavailableReason(reason: TurnCostSnapshot["reason"]): string {
  switch (reason) {
    case "rates_unavailable":
      return "No price is available for this model.";
    case "tier_unavailable":
      return "No price is available for the selected service tier.";
    case "model_unavailable":
      return "The model used for this turn was not recorded.";
    case "incomplete_usage":
      return "The provider did not report enough token usage to calculate a price.";
    case "invalid_usage":
      return "The provider reported inconsistent token counts.";
    default:
      return "The provider did not report billable token usage.";
  }
}
