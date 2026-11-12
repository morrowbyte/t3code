import type { ExecutionUsageEntry } from "@t3tools/contracts";

export function summarizeExecutions(entries: readonly ExecutionUsageEntry[]) {
  const known = entries.filter((entry) => entry.estimatedCostUsd !== null);
  return {
    estimatedCostUsd:
      known.length > 0
        ? known.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? 0), 0)
        : null,
    incomplete: entries.some(
      (entry) => entry.partial || entry.unmeasuredSubagents || entry.delegatedChildren > 0,
    ),
    unknown: entries.filter((entry) => entry.estimatedCostUsd === null).length,
  };
}

export function samePromptExecutions(entries: readonly ExecutionUsageEntry[], key: string) {
  return key === "" ? [] : entries.filter((entry) => entry.taskKey === key).slice(0, 4);
}

export function peakExecutionCost(entries: readonly ExecutionUsageEntry[]) {
  return entries.reduce<number | null>(
    (peak, entry) =>
      entry.estimatedCostUsd === null ? peak : Math.max(peak ?? 0, entry.estimatedCostUsd),
    null,
  );
}

export function executionCostLabel(value: number | null, partial = false) {
  if (value === null) return "Unknown";
  const formatted =
    value > 0 && value < 0.001
      ? "< $0.001"
      : new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 3,
          maximumFractionDigits: 3,
        }).format(value);
  return `≈ ${formatted}${partial ? " · partial" : ""}`;
}

export function executionDurationLabel(value: number | null) {
  if (value === null) return "Unknown";
  return value < 60_000 ? `${Math.round(value / 1000)}s` : `${Math.round(value / 60_000)}m`;
}
