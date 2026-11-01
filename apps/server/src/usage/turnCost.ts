import type { ModelSelection, TurnCostSnapshot, TurnTokenUsage } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import { lookupRate, type RateTable } from "./usagePricing.ts";

export interface TurnCostInput {
  readonly usage?: TurnTokenUsage;
  readonly modelSelection?: ModelSelection;
}

export function priceTurnUsage(
  input: TurnCostInput,
  pricing: {
    readonly rates: RateTable;
    readonly overrides: RateTable;
    readonly pricedAt: string;
    readonly ratesFetchedAt: string | null;
  },
): TurnCostSnapshot {
  const { usage, modelSelection } = input;
  const tier = modelSelection && getModelSelectionStringOptionValue(modelSelection, "serviceTier");
  const fast = modelSelection && getModelSelectionBooleanOptionValue(modelSelection, "fastMode");
  const serviceTier =
    tier === "ultrafast" ? "ultrafast" : tier === "priority" || fast ? "fast" : "standard";
  const base = {
    model: modelSelection?.model ?? null,
    serviceTier,
    source: null,
    pricedAt: pricing.pricedAt,
    ratesFetchedAt: pricing.ratesFetchedAt,
    ...(usage === undefined ? {} : { usage }),
  } as const;
  const unavailable = (reason: NonNullable<TurnCostSnapshot["reason"]>): TurnCostSnapshot => ({
    ...base,
    status: "unavailable",
    reason,
  });
  if (usage === undefined || usage.usageStatus === "unavailable")
    return unavailable("usage_unavailable");
  if (usage.inputTokens === undefined || usage.outputTokens === undefined)
    return unavailable("incomplete_usage");
  if (!modelSelection) return unavailable("model_unavailable");
  if (tier && !["default", "standard", "priority", "ultrafast"].includes(tier))
    return unavailable("tier_unavailable");

  const cached = usage.cachedInputTokens ?? 0;
  const created = usage.cacheCreationTokens ?? 0;
  const uncached = usage.inputTokens - cached - created;
  if (uncached < 0 || (usage.reasoningTokens ?? 0) > usage.outputTokens)
    return unavailable("invalid_usage");
  const override = pricing.overrides.get(modelSelection.model.trim());
  const rate = override ?? lookupRate(pricing.rates, modelSelection.model);
  if (!rate) return unavailable("rates_unavailable");
  // Custom prices explicitly define the effective tariff; public prices must match the requested tier.
  const selected = override ?? (serviceTier === "standard" ? rate : rate[serviceTier]);
  if (!selected) return unavailable("tier_unavailable");
  const rates = {
    inputCostPerToken: selected.inputCostPerToken,
    outputCostPerToken: selected.outputCostPerToken,
    cacheReadCostPerToken: selected.cacheReadCostPerToken,
    cacheCreationCostPerToken: selected.cacheCreationCostPerToken,
  };
  if (Object.values(rates).some((value) => !Number.isFinite(value) || value < 0))
    return unavailable("rates_unavailable");
  const categoryUsd = {
    input: uncached * rates.inputCostPerToken,
    cacheRead: cached * rates.cacheReadCostPerToken,
    cacheWrite: created * rates.cacheCreationCostPerToken,
    output: usage.outputTokens * rates.outputCostPerToken,
  };
  const amountUsd = Object.values(categoryUsd).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(amountUsd)) return unavailable("invalid_usage");
  return {
    ...base,
    status: usage.usageStatus,
    ...(usage.usageStatus === "partial" ? { reason: "incomplete_usage" as const } : {}),
    source: override ? "custom" : "litellm",
    amountUsd,
    categoryUsd,
    rates,
  };
}
