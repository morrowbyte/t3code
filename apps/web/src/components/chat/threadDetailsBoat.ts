import type { BoatInstance, ProjectId, ThreadId } from "@t3tools/contracts";

export const BOAT_SIZE_LABELS = {
  small: "Small",
  default: "Default",
  large: "Large",
  xlarge: "XLarge",
};

const inactiveStates = new Set(["archived", "stopped", "deleted", "error"]);

export function selectThreadBoats(
  instances: readonly BoatInstance[],
  projectId: ProjectId,
  threadId: ThreadId,
) {
  return instances
    .filter(
      (instance) =>
        instance.projectId === projectId &&
        instance.threadId === threadId &&
        instance.state !== "deleted",
    )
    .toSorted(
      (a, b) =>
        Number(inactiveStates.has(a.state)) - Number(inactiveStates.has(b.state)) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.requestId.localeCompare(b.requestId),
    );
}

export function boatRuntimeLabel(instance: BoatInstance, nowMs: number) {
  if (inactiveStates.has(instance.state)) return null;
  const remaining = Date.parse(instance.expiresAt) - nowMs;
  if (!Number.isFinite(remaining)) return "Runtime unknown";
  if (remaining <= 0) return "Runtime ended";
  const minutes = Math.ceil(remaining / 60000);
  return `${minutes} min left`;
}
