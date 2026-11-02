import { describe, expect, it } from "@effect/vitest";
import {
  ProviderThreadId,
  ProviderTurnId,
  NodeId,
  TurnItemId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { answerCostPresentation } from "./answerCost.ts";

const itemId = TurnItemId.make("answer");
const turn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("turn"),
  providerThreadId: ProviderThreadId.make("thread"),
  nodeId: NodeId.make("node"),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt: null,
  completedAt: null,
  cost: {
    status: "complete",
    model: "example-model",
    serviceTier: "fast",
    source: "litellm",
    pricedAt: "2026-11-01T10:00:00Z",
    ratesFetchedAt: "2026-11-01T09:00:00Z",
    amountUsd: 0.024,
    answerItemId: itemId,
    usage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 200,
      reasoningTokens: 100,
      hasSubagents: true,
    },
  },
};

describe("answer cost binding", () => {
  it("shows a turn total only on its bound answer, including after JSON reload", () => {
    const restored = JSON.parse(JSON.stringify(turn)) as OrchestrationV2ProviderTurn;
    expect(answerCostPresentation(restored, itemId)?.label).toBe("≈ $0.024");
    expect(answerCostPresentation(null, itemId, restored.cost)?.label).toBe("≈ $0.024");
    expect(
      answerCostPresentation(null, TurnItemId.make("intermediate-answer"), restored.cost),
    ).toBeNull();
    expect(answerCostPresentation(restored, TurnItemId.make("intermediate-answer"))).toBeNull();
    expect(answerCostPresentation({ ...turn, status: "running" }, itemId)).toBeNull();
    expect(answerCostPresentation(turn, itemId)?.detail).toContain("Subagent costs are excluded.");
  });

  it("keeps partial, unavailable and tiny costs honest", () => {
    expect(
      answerCostPresentation({ ...turn, cost: { ...turn.cost!, status: "partial" } }, itemId)
        ?.label,
    ).toBe("≈ $0.024 · partial");
    expect(
      answerCostPresentation(
        {
          ...turn,
          cost: {
            ...turn.cost!,
            status: "unavailable",
            amountUsd: undefined,
            reason: "rates_unavailable",
          },
        },
        itemId,
      )?.label,
    ).toBe("Cost unavailable");
    expect(
      answerCostPresentation({ ...turn, cost: { ...turn.cost!, amountUsd: 0.000001 } }, itemId)
        ?.label,
    ).toBe("< $0.001");
    expect(answerCostPresentation({ ...turn, cost: undefined }, itemId)?.label).toBe(
      "Cost unavailable",
    );
  });
});
