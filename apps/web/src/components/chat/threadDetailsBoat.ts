import type { BoatInstance, ProjectId } from "@t3tools/contracts";

export const BOAT_SIZE_LABELS = {
  small: "Small",
  default: "Default",
  large: "Large",
  xlarge: "XLarge",
};

const inactiveStates = new Set(["archived", "stopped", "deleted", "error"]);

export function summarizeProjectBoat(instances: readonly BoatInstance[], projectId: ProjectId) {
  const active = { small: 0, default: 0, large: 0, xlarge: 0 };
  let costUsd = 0;
  for (const instance of instances) {
    if (instance.projectId !== projectId) continue;
    costUsd += instance.costUsd;
    if (!inactiveStates.has(instance.state)) active[instance.size] += 1;
  }
  return { active, costUsd };
}
