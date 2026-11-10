import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { AnyRouter } from "@tanstack/react-router";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadDetails } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { randomUUID } from "../lib/utils";
import { PetInbox, type PetCandidate } from "./PetInbox";

interface WatchedEnvironment {
  threads: readonly OrchestrationV2ThreadShell[];
  live: boolean;
  seenRuns: Map<ThreadId, string | null>;
  results: Set<ThreadId>;
  working: Set<ThreadId>;
  details: Map<ThreadId, () => void>;
  stop: () => void;
}

export function startDesktopPet(registry: AtomRegistry.AtomRegistry, router: AnyRouter) {
  const bridge = window.desktopBridge;
  if (!bridge?.setPetProjection || !bridge.onPetEvent) return () => {};
  const inbox = new PetInbox(randomUUID);
  const watched = new Map<EnvironmentId, WatchedEnvironment>();
  let scheduled = false;
  let stopped = false;
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!stopped) project();
    });
  };
  const project = () => {
    const candidates: PetCandidate[] = [];
    let workingCount = 0;
    for (const [environmentId, entry] of watched) {
      if (!entry.live) continue;
      for (const shell of entry.threads) {
        if (shell.deletedAt !== null || shell.archivedAt !== null) continue;
        const ref: ScopedThreadRef = { environmentId, threadId: shell.id };
        const presented = presentThreadShell(environmentId, shell);
        if (
          presented.runtime &&
          ["queued", "preparing", "starting", "running", "waiting"].includes(
            presented.runtime.status,
          )
        )
          workingCount++;
        const request = shell.pendingRuntimeRequest;
        const pending = entry.details.has(shell.id)
          ? registry.get(environmentThreadDetails.pendingRequestsAtom(ref))
          : null;
        const add = (kind: PetCandidate["kind"], id: string) =>
          candidates.push({ key: JSON.stringify([environmentId, shell.id, kind, id]), kind, ref });
        for (const approval of pending?.approvals ?? []) add("approval", approval.requestId);
        for (const question of pending?.userInputs ?? []) add("question", question.requestId);
        if (
          request &&
          !pending?.approvals.some((item) => item.requestId === request.id) &&
          !pending?.userInputs.some((item) => item.requestId === request.id)
        ) {
          add(request.kind === "user_input" ? "question" : "approval", request.id);
        }
        if (
          entry.results.has(shell.id) &&
          registry.get(environmentThreadDetails.statusAtom(ref)) === "live"
        ) {
          const detail = registry.get(environmentThreadDetails.quietThreadAtom(ref));
          const answer = detail?.projection.turnItems.findLast(
            (item) =>
              item.runId === shell.latestRunId &&
              item.type === "assistant_message" &&
              item.status === "completed" &&
              !item.streaming,
          );
          if (
            answer &&
            presented.latestRun?.status === "completed" &&
            !shell.activityRunStatus &&
            !shell.latestRunStopRequested
          )
            add("result", answer.id);
        }
      }
    }
    const projection = inbox.update(
      candidates,
      Math.min(workingCount, 10_000),
      new Set([...watched].filter(([, entry]) => !entry.live).map(([id]) => id)),
    );
    if (projection) void bridge.setPetProjection(projection).catch(() => {});
  };
  const observe = (environmentId: EnvironmentId, entry: WatchedEnvironment) => {
    const shell = registry.get(environmentShell.stateValueAtom(environmentId));
    entry.live = shell.status === "live" && Option.isSome(shell.snapshot);
    if (!entry.live || Option.isNone(shell.snapshot)) {
      schedule();
      return;
    }
    entry.threads = shell.snapshot.value.threads;
    const retained = new Set<ThreadId>();
    for (const thread of entry.threads) {
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      const priorRun = entry.seenRuns.get(thread.id);
      if (priorRun !== undefined && priorRun !== thread.latestRunId) {
        entry.results.delete(thread.id);
        if (presentThreadShell(environmentId, thread).latestRun?.status === "completed")
          entry.results.add(thread.id);
      }
      const presented = presentThreadShell(environmentId, thread);
      if (entry.working.has(thread.id) && presented.latestRun?.status === "completed")
        entry.results.add(thread.id);
      if (
        ["queued", "preparing", "starting", "running", "waiting"].includes(
          thread.activityRunStatus ?? thread.status,
        )
      )
        entry.working.add(thread.id);
      else entry.working.delete(thread.id);
      entry.seenRuns.set(thread.id, thread.latestRunId);
      while (entry.results.size > 100) entry.results.delete(entry.results.values().next().value!);
      const needsDetail = thread.pendingRuntimeRequest !== null || entry.results.has(thread.id);
      if (needsDetail) {
        retained.add(thread.id);
        if (!entry.details.has(thread.id)) {
          const ref = { environmentId, threadId: thread.id };
          const stops = [
            registry.subscribe(environmentThreadDetails.pendingRequestsAtom(ref), schedule),
            registry.subscribe(environmentThreadDetails.quietThreadAtom(ref), schedule),
            registry.subscribe(environmentThreadDetails.statusAtom(ref), schedule),
          ];
          entry.details.set(thread.id, () => stops.forEach((stop) => stop()));
        }
      }
    }
    for (const [id, stop] of entry.details)
      if (!retained.has(id)) {
        stop();
        entry.details.delete(id);
      }
    const ids = new Set(entry.threads.map((thread) => thread.id));
    for (const id of entry.seenRuns.keys())
      if (!ids.has(id)) {
        entry.seenRuns.delete(id);
        entry.results.delete(id);
      }
    schedule();
  };
  const sync = () => {
    const ids = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    for (const [id, entry] of watched)
      if (!ids.has(id)) {
        entry.stop();
        watched.delete(id);
      }
    for (const id of ids)
      if (!watched.has(id)) {
        const entry: WatchedEnvironment = {
          threads: [],
          live: false,
          seenRuns: new Map(),
          results: new Set(),
          working: new Set(),
          details: new Map(),
          stop: () => {},
        };
        watched.set(id, entry);
        const stop = registry.subscribe(
          environmentShell.stateValueAtom(id),
          () => observe(id, entry),
          { immediate: true },
        );
        entry.stop = () => {
          stop();
          for (const dispose of entry.details.values()) dispose();
        };
      }
    schedule();
  };
  const unsubscribe = registry.subscribe(environmentSummaries.environmentIdsAtom, sync, {
    immediate: true,
  });
  const stopEvents = bridge.onPetEvent((event) => {
    if (event.type !== "action") return;
    project();
    const item = inbox.resolve(event.id);
    if (!item) return;
    inbox.dismiss(event.id);
    schedule();
    if (event.action === "open") {
      void bridge.revealWindow();
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(item.ref),
      });
    }
  });
  return () => {
    stopped = true;
    unsubscribe();
    stopEvents();
    for (const entry of watched.values()) entry.stop();
  };
}
