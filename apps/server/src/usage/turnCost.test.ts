import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type TurnTokenUsage } from "@t3tools/contracts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";
import { priceTurnUsage } from "./turnCost.ts";

const usage: TurnTokenUsage = {
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: true,
  inputTokens: 1000,
  cachedInputTokens: 600,
  cacheCreationTokens: 100,
  outputTokens: 200,
  reasoningTokens: 150,
};
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "example-model" };
const pricing = {
  rates: parseRateTable({
    "example-model": {
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000008,
      cache_read_input_token_cost: 0.0000002,
      cache_creation_input_token_cost: 0.000003,
      input_cost_per_token_priority: 0.000004,
      output_cost_per_token_priority: 0.000016,
    },
  }),
  overrides: new Map(),
  pricedAt: "2026-11-01T10:00:00Z",
  ratesFetchedAt: "2026-11-01T09:00:00Z",
};

describe("per-turn cost snapshots", () => {
  it("prices disjoint input/cache categories and includes reasoning only once", () => {
    const cost = priceTurnUsage({ usage, modelSelection }, pricing);
    expect(cost.status).toBe("complete");
    expect(cost.amountUsd).toBeCloseTo(0.00262);
    expect(cost.categoryUsd).toEqual({
      input: expect.closeTo(0.0006),
      cacheRead: expect.closeTo(0.00012),
      cacheWrite: expect.closeTo(0.0003),
      output: expect.closeTo(0.0016),
    });
    expect(cost.usage?.hasSubagents).toBe(true);
  });

  it("uses priority rates and preserves a detached rate snapshot across refreshes", () => {
    const selected = { ...modelSelection, options: [{ id: "serviceTier", value: "priority" }] };
    const cost = priceTurnUsage({ usage, modelSelection: selected }, pricing);
    expect(cost.serviceTier).toBe("fast");
    expect(cost.amountUsd).toBeCloseTo(0.00524);
    const changed = {
      ...pricing,
      rates: parseRateTable({
        "example-model": { input_cost_per_token: 1, output_cost_per_token: 1 },
      }),
    };
    expect(priceTurnUsage({ usage, modelSelection }, changed).amountUsd).not.toBe(cost.amountUsd);
    expect(JSON.parse(JSON.stringify(cost)).amountUsd).toBeCloseTo(0.00524);
    expect(cost.rates?.inputCostPerToken).toBe(0.000004);
  });

  it("does not silently price an unsupported tier at the standard rate", () => {
    for (const tier of ["ultrafast", "flex"]) {
      const cost = priceTurnUsage(
        {
          usage,
          modelSelection: { ...modelSelection, options: [{ id: "serviceTier", value: tier }] },
        },
        pricing,
      );
      expect(cost.reason).toBe("tier_unavailable");
      expect(cost.amountUsd).toBeUndefined();
    }
  });

  it("retains explicit custom zero pricing and honors overrides offline", () => {
    const overrides = createOverrideRateTable({
      "example-model": { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 },
    });
    const cost = priceTurnUsage(
      { usage, modelSelection },
      { ...pricing, rates: new Map(), overrides },
    );
    expect(cost).toMatchObject({ amountUsd: 0, source: "custom", status: "complete" });
  });

  it("never turns absent, partial or inconsistent usage into a complete zero price", () => {
    for (const input of [
      { modelSelection },
      { modelSelection, usage: { ...usage, usageStatus: "unavailable" as const } },
      {
        modelSelection,
        usage: { ...usage, usageStatus: "partial" as const, outputTokens: undefined },
      },
      { modelSelection, usage: { ...usage, cachedInputTokens: 2000 } },
    ]) {
      expect(priceTurnUsage(input, pricing).amountUsd).toBeUndefined();
    }
    expect(
      priceTurnUsage({ modelSelection, usage: { ...usage, usageStatus: "partial" } }, pricing),
    ).toMatchObject({ status: "partial", amountUsd: expect.closeTo(0.00262) });
    expect(
      priceTurnUsage({ usage, modelSelection: { ...modelSelection, model: "missing" } }, pricing),
    ).toMatchObject({ status: "unavailable", reason: "rates_unavailable" });
  });
});
