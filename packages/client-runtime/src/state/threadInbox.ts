import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { toSortableTimestamp } from "./threadSort.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> &
  Partial<Pick<EnvironmentThreadShell, "settledOverride" | "pendingBackgroundTasks">>;

export function isThreadAwaitingInput(
  thread: Pick<
    WorkingThreadInput,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "settledOverride"
  >,
): boolean {
  return (
    thread.settledOverride !== "settled" &&
    (thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.pendingSubagentRequest != null)
  );
}

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  // A new admitted run clears this override canonically; stale run/request
  // summaries must never undo an explicit settlement on their own.
  if (thread.settledOverride === "settled" || isThreadAwaitingInput(thread)) return false;
  if (
    !threadRuntimeIsActive(thread.runtime) &&
    !(
      thread.runtime?.status === "idle" &&
      backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
    )
  )
    return false;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

export function workingThreadKeys(
  threads: ReadonlyArray<WorkingThreadInput & Pick<EnvironmentThreadShell, "environmentId" | "id">>,
): ReadonlySet<string> {
  return new Set(
    threads.filter(isThreadWorking).map((thread) => `${thread.environmentId}:${thread.id}`),
  );
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/**
 * Keep one at module scope so the inbox order survives routes that unmount the
 * list. Call `observe` with every thread shell on each list rebuild, or with
 * null to reset while the beta is off.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
    `${thread.environmentId}:${thread.id}`;
  let lastWorkingKeys: ReadonlySet<string> | null = null;
  const returns = new Map<string, number>();
  return {
    observe(threads: ReadonlyArray<WorkingThreadInput & InboxThreadInput> | null): void {
      if (threads === null) {
        lastWorkingKeys = null;
        returns.clear();
        return;
      }
      const working = new Set<string>();
      const present = new Set<string>();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        if (isThreadWorking(thread)) working.add(key);
      }
      for (const key of returns.keys()) {
        if (!present.has(key)) returns.delete(key);
      }
      // @effect-diagnostics-next-line globalDate:off
      const at = Date.now();
      for (const key of lastWorkingKeys ?? []) {
        if (present.has(key) && !working.has(key)) returns.set(key, at);
      }
      lastWorkingKeys = working;
    },
    returnedAt: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
      returns.get(keyOf(thread)),
  };
}
