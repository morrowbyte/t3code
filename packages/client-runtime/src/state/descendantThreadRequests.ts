import {
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";
import type { PendingThreadRequests } from "./threadRequests.ts";
import type { EnvironmentThreadStatus } from "./threadState.ts";

export interface DescendantThreadRequests {
  readonly origin: ScopedThreadRef;
  readonly title: string;
  readonly runtimeMode: OrchestrationV2ThreadShell["runtimeMode"];
  readonly worktreePath: string | null;
  readonly requests: PendingThreadRequests | null;
  readonly status: EnvironmentThreadStatus;
}

export function selectDescendantRequestOrigins(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  parentThreadId: ThreadId,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const byId = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of threads) {
    if (!byId.has(thread.id)) byId.set(thread.id, thread);
  }
  const origins: OrchestrationV2ThreadShell[] = [];
  for (const thread of byId.values()) {
    const kind = thread.pendingRuntimeRequest?.kind;
    if (
      thread.id === parentThreadId ||
      thread.deletedAt !== null ||
      kind === undefined ||
      // Provider-native children mirror requests owned by their parent.
      isProviderNativeSubagentThread(thread)
    ) {
      continue;
    }
    const seen = new Set<ThreadId>([thread.id]);
    let current: OrchestrationV2ThreadShell | undefined = thread;
    while (current !== undefined) {
      const { parentThreadId: ancestorId, relationshipToParent } = current.lineage;
      if (
        ancestorId === null ||
        seen.has(ancestorId) ||
        (relationshipToParent !== "subagent" && relationshipToParent !== "fork")
      ) {
        break;
      }
      if (ancestorId === parentThreadId) {
        origins.push(thread);
        break;
      }
      seen.add(ancestorId);
      current = byId.get(ancestorId);
    }
  }
  return origins;
}

export function createDescendantThreadRequestsAtom(input: {
  readonly threadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly pendingRequestsAtom: (ref: ScopedThreadRef) => Atom.Atom<PendingThreadRequests | null>;
  readonly statusAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadStatus>;
}) {
  const family = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previous: ReadonlyArray<DescendantThreadRequests> = [];
    return Atom.make((get): ReadonlyArray<DescendantThreadRequests> => {
      const origins = selectDescendantRequestOrigins(
        get(input.threadsAtom(ref.environmentId)),
        ref.threadId,
      );
      // The shell only summarizes the newest request; older questions may still be pending.
      const previousById = new Map(previous.map((group) => [group.origin.threadId, group]));
      const groups: DescendantThreadRequests[] = [];
      for (const shell of origins) {
        const prior = previousById.get(shell.id);
        const origin = prior?.origin ?? { environmentId: ref.environmentId, threadId: shell.id };
        const status = get(input.statusAtom(origin));
        if (status === "deleted") continue;
        const pending = get(input.pendingRequestsAtom(origin));
        if (
          status === "live" &&
          pending !== null &&
          pending.approvals.length === 0 &&
          pending.userInputs.length === 0
        ) {
          continue;
        }
        // Cached details can predate an answer in another view. Wait for live reconciliation.
        const requests = status === "live" ? pending : null;
        groups.push(
          prior !== undefined &&
            prior.title === shell.title &&
            prior.runtimeMode === shell.runtimeMode &&
            prior.worktreePath === shell.worktreePath &&
            prior.requests === requests &&
            prior.status === status
            ? prior
            : {
                origin,
                title: shell.title,
                runtimeMode: shell.runtimeMode,
                worktreePath: shell.worktreePath,
                requests,
                status,
              },
        );
      }
      if (arrayElementsEqual(previous, groups)) return previous;
      previous = groups;
      return previous;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-descendant-thread-requests:${key}`));
  });
  return (ref: ScopedThreadRef) => family(threadKey(ref));
}
