import type { EnvironmentThreadShell } from "./models.ts";

export type CoordinationThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "lineage" | "archivedAt" | "deletedAt" | "snoozedUntil" | "goal"
>;

export function isCoordinationThread(thread: CoordinationThread, environmentId: string): boolean {
  return (
    thread.environmentId === environmentId &&
    thread.lineage.parentThreadId === null &&
    thread.lineage.relationshipToParent === null &&
    thread.deletedAt === null
  );
}

export function addCoordinationMember(
  members: readonly string[],
  coordinator: CoordinationThread,
  candidate: CoordinationThread,
): readonly string[] {
  if (
    !isCoordinationThread(coordinator, coordinator.environmentId) ||
    !isCoordinationThread(candidate, coordinator.environmentId) ||
    candidate.id === coordinator.id ||
    members.includes(candidate.id)
  )
    return members;
  return [...members, candidate.id];
}

export function removeCoordinationMember(members: readonly string[], threadId: string) {
  return members.filter((id) => id !== threadId);
}

export function resolveCoordinationMember<T extends CoordinationThread>(input: {
  readonly coordinator: CoordinationThread;
  readonly members: readonly string[];
  readonly selectedId: string;
  readonly threads: readonly T[];
}): T | null {
  if (
    !isCoordinationThread(input.coordinator, input.coordinator.environmentId) ||
    input.selectedId === input.coordinator.id ||
    !input.members.includes(input.selectedId)
  )
    return null;
  return (
    input.threads.find(
      (thread) =>
        thread.id === input.selectedId &&
        isCoordinationThread(thread, input.coordinator.environmentId),
    ) ?? null
  );
}

export function coordinationActionBlock(input: {
  readonly coordinator: CoordinationThread;
  readonly target: CoordinationThread | null;
  readonly allowed: boolean;
  readonly detailLive: boolean;
  readonly queueHeld: boolean;
}): string | null {
  if (!input.allowed) return "This connection is read-only.";
  if (input.target === null) return "Select an available member thread.";
  for (const thread of [input.coordinator, input.target]) {
    if (!isCoordinationThread(thread, input.coordinator.environmentId))
      return "Thread unavailable.";
    if (thread.archivedAt !== null) return "Archived threads must be opened separately.";
    if (thread.snoozedUntil != null || thread.goal?.status === "paused") {
      return "Paused or snoozed threads must be opened separately.";
    }
  }
  if (!input.detailLive) return "Waiting for current member state.";
  if (input.queueHeld) return "The member queue is paused. Open the thread to review it.";
  return null;
}
