import { describe, expect, it } from "vite-plus/test";
import type { ExecutionUsageEntry } from "@t3tools/contracts";
import {
  executionCostLabel,
  peakExecutionCost,
  samePromptExecutions,
  summarizeExecutions,
} from "./executionUsage";

function entry(overrides: Partial<ExecutionUsageEntry> = {}): ExecutionUsageEntry {
  return {
    runId: "run" as ExecutionUsageEntry["runId"],
    threadId: "thread" as ExecutionUsageEntry["threadId"],
    projectId: "project" as ExecutionUsageEntry["projectId"],
    threadTitle: "Thread",
    parentThreadId: null,
    modelSelection: {
      instanceId: "codex" as ExecutionUsageEntry["modelSelection"]["instanceId"],
      model: "model",
    },
    origin: "web",
    status: "completed",
    requestedAt: "2026-11-12T10:00:00Z",
    durationMs: null,
    taskKey: "same",
    prompt: "Task",
    result: "Result",
    estimatedCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    missingCostTurns: 1,
    partial: true,
    unmeasuredSubagents: false,
    delegatedChildren: 0,
    contextUsedTokens: null,
    contextMaxTokens: null,
    pricing: [],
    nativeChildren: [],
    nativeChildrenOmitted: 0,
    ...overrides,
  };
}

describe("execution usage", () => {
  it("preserves unknown totals and marks incomplete sums without hiding measured zero", () => {
    expect(summarizeExecutions([entry()])).toMatchObject({ estimatedCostUsd: null, unknown: 1 });
    expect(
      summarizeExecutions([entry(), entry({ estimatedCostUsd: 0.02, partial: false })]),
    ).toEqual({ estimatedCostUsd: 0.02, incomplete: true, unknown: 1 });
    expect(
      summarizeExecutions([
        entry({ estimatedCostUsd: 0.02, partial: false, delegatedChildren: 1 }),
      ]),
    ).toEqual({ estimatedCostUsd: 0.02, incomplete: true, unknown: 0 });
    const measured = entry({ estimatedCostUsd: 0.02, partial: false });
    expect(summarizeExecutions([measured])).toEqual({
      estimatedCostUsd: 0.02,
      incomplete: false,
      unknown: 0,
    });
    expect(summarizeExecutions([measured], true)).toEqual({
      estimatedCostUsd: 0.02,
      incomplete: true,
      unknown: 0,
    });
    expect(executionCostLabel(null)).toBe("Unknown");
    expect(peakExecutionCost([entry()])).toBeNull();
    expect(peakExecutionCost([entry(), entry({ estimatedCostUsd: 0 })])).toBe(0);
    expect(executionCostLabel(0)).toContain("0.000");
    expect(executionCostLabel(0.00001)).toBe("≈ < $0.001");
  });
  it("compares at most four saved matching prompts and never groups unknown tasks", () => {
    const entries = [entry({ taskKey: "other" }), ...Array.from({ length: 6 }, () => entry())];
    expect(samePromptExecutions(entries, "same")).toHaveLength(4);
    expect(samePromptExecutions(entries, "")).toEqual([]);
  });
});
