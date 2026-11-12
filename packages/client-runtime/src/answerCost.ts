import type {
  ModelSelection,
  OrchestrationV2ProviderTurn,
  TurnCostSnapshot,
  TurnItemId,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export function executionConfiguration(selection?: ModelSelection | null) {
  return {
    provider: selection?.instanceId ?? "unknown",
    model: selection?.model ?? "unknown",
    reasoning: selection
      ? (getModelSelectionStringOptionValue(selection, "reasoningEffort") ??
        getModelSelectionStringOptionValue(selection, "effort") ??
        "unknown")
      : "unknown",
    serviceTier: selection
      ? (getModelSelectionStringOptionValue(selection, "serviceTier") ??
        (getModelSelectionBooleanOptionValue(selection, "fastMode") === true ? "Fast" : "unknown"))
      : "unknown",
  };
}

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
  snapshot?: OrchestrationV2ProviderTurn["cost"],
  execution?: ModelSelection | null,
): { readonly label: string; readonly detail: string } | null {
  if (snapshot === undefined && (!turn || turn.status === "pending" || turn.status === "running"))
    return null;
  const cost = snapshot ?? turn?.cost;
  if (cost?.answerItemId != null && cost.answerItemId !== itemId) return null;
  const recorded = executionConfiguration(execution);
  const configuration = [
    `Provider: ${recorded.provider}`,
    `Run model: ${recorded.model}`,
    `Reasoning: ${recorded.reasoning}`,
    `Service tier: ${recorded.serviceTier}`,
    `Context: ${turn?.tokenUsage ? `${count.format(turn.tokenUsage.usedTokens)} / ${turn.tokenUsage.maxTokens == null ? "unknown" : count.format(turn.tokenUsage.maxTokens)} tokens` : "unknown"}`,
    ...(execution?.options?.length
      ? [`Run options: ${execution.options.map(({ id, value }) => `${id}=${value}`).join(" · ")}`]
      : []),
  ];
  if (!cost || cost.answerItemId === null) {
    return {
      label: "Cost unavailable",
      detail: [
        ...configuration,
        "No saved API cost measurement is available for this response.",
      ].join("\n"),
    };
  }
  const usage = cost.usage;
  const details = [
    ...configuration,
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
