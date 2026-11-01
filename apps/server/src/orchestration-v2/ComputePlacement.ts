// @effect-diagnostics-next-line nodeBuiltinImport:off - Request IDs need a synchronous hash without a service dependency.
import * as NodeCrypto from "node:crypto";
import type {
  BoatInstance,
  BoatState,
  HostResourcesSnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { StorageFailure } from "@t3tools/shared/node/storagePressure";

export interface ComputePlacementInput {
  readonly projectId: ProjectId;
  readonly ownerThreadId: ThreadId;
  readonly requestId: string;
  readonly resources: HostResourcesSnapshot | null;
  readonly storageFailure: StorageFailure | null;
  readonly forceBoat: boolean;
  readonly boat: BoatState | null;
}

export type ComputePlacement =
  | { readonly target: "local"; readonly reason: "healthy" | "boat_disabled" }
  | {
      readonly target: "boat";
      readonly requestId: string;
      readonly action: "start" | "resume" | "renew";
      readonly reason: "forced" | "cpu_pressure" | "memory_pressure";
    }
  | {
      readonly target: "blocked";
      readonly reason:
        | StorageFailure["code"]
        | "resources_unavailable"
        | "resources_invalid"
        | "boat_unavailable"
        | "boat_unconfigured"
        | "boat_disabled"
        | "boat_capacity"
        | "boat_conflict";
    };

export function computeRequestId(projectId: ProjectId, threadId: ThreadId): string {
  const workOwner = /^work-owner:([a-f0-9]{64}):.+$/.exec(threadId);
  if (workOwner) return `work-${workOwner[1]}`;
  return `compute-${NodeCrypto.createHash("sha256").update(`${projectId}\n${threadId}`).digest("hex")}`;
}

const GiB = 1024 ** 3;

function validResources(resources: HostResourcesSnapshot): boolean {
  return (
    Number.isSafeInteger(resources.sampledAt) &&
    resources.sampledAt >= 0 &&
    resources.cpuUtilization !== null &&
    Number.isFinite(resources.cpuUtilization) &&
    resources.cpuUtilization >= 0 &&
    resources.cpuUtilization <= 1 &&
    Number.isSafeInteger(resources.cpuCount) &&
    resources.cpuCount > 0 &&
    Number.isSafeInteger(resources.availableMemoryBytes) &&
    resources.availableMemoryBytes >= 0 &&
    Number.isSafeInteger(resources.totalMemoryBytes) &&
    resources.totalMemoryBytes > 0 &&
    resources.availableMemoryBytes <= resources.totalMemoryBytes
  );
}

function reuseAction(instance: BoatInstance): "start" | "renew" | "resume" | undefined {
  if (instance.state === "provisioning") return instance.sandboxId ? "resume" : "start";
  if (!instance.sandboxId) return undefined;
  switch (instance.state) {
    case "idle":
    case "ready":
    case "running":
      return "renew";
    case "archived":
    case "stopped":
      return "resume";
    default:
      return undefined;
  }
}

export function chooseComputePlacement(input: ComputePlacementInput): ComputePlacement {
  if (input.storageFailure !== null) {
    return { target: "blocked", reason: input.storageFailure.code };
  }
  let reason: "forced" | "cpu_pressure" | "memory_pressure" = "forced";
  if (!input.forceBoat) {
    const resources = input.resources;
    if (resources === null || resources.cpuUtilization === null) {
      return { target: "blocked", reason: "resources_unavailable" };
    }
    if (!validResources(resources)) return { target: "blocked", reason: "resources_invalid" };
    if (resources.availableMemoryBytes <= Math.max(2 * GiB, resources.totalMemoryBytes * 0.1)) {
      reason = "memory_pressure";
    } else if (resources.cpuUtilization >= 0.9) reason = "cpu_pressure";
    else return { target: "local", reason: "healthy" };
  }
  const state = input.boat;
  if (state === null) return { target: "blocked", reason: "boat_unavailable" };
  if (reason === "cpu_pressure" && !state.projects[input.projectId]?.enabled) {
    return { target: "local", reason: "boat_disabled" };
  }
  if (!state.configured) return { target: "blocked", reason: "boat_unconfigured" };
  if (!state.projects[input.projectId]?.enabled) {
    return { target: "blocked", reason: "boat_disabled" };
  }
  const candidates = state.instances.flatMap((instance) => {
    if (instance.projectId !== input.projectId || instance.threadId !== input.ownerThreadId) {
      return [];
    }
    const action = reuseAction(instance);
    return action === undefined ? [] : [{ instance, action }];
  });
  const chosen =
    candidates.find(({ instance }) => instance.requestId === input.requestId) ??
    candidates.find(({ action }) => action === "renew") ??
    candidates[0];
  if (chosen) {
    return { target: "boat", reason, requestId: chosen.instance.requestId, action: chosen.action };
  }
  if (state.instances.some((instance) => instance.requestId === input.requestId)) {
    return { target: "blocked", reason: "boat_conflict" };
  }
  if (!state.account?.canStart) return { target: "blocked", reason: "boat_capacity" };
  return { target: "boat", reason, requestId: input.requestId, action: "start" };
}
