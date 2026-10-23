import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxReturnTracker,
  isThreadWorking,
  isThreadAwaitingInput,
  workingThreadKeys,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("Working membership", () => {
  const running = thread("run", true);
  const completed = {
    runId: RunId.make("run-completed"),
    status: "completed" as const,
    requestedAt: running.createdAt,
    startedAt: running.createdAt,
    completedAt: running.createdAt,
    assistantMessageId: null,
  };

  it.each([null, completed])("does not count connected idle with latest run %s", (latestRun) => {
    for (const activeRunId of [null, completed.runId]) {
      expect(
        isThreadWorking({
          ...running,
          latestRun,
          runtime: { ...running.runtime!, status: "idle", activeRunId },
        }),
      ).toBe(false);
    }
  });

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "keeps %s work until explicit settlement",
    (status) => {
      const active = { ...running, runtime: { ...running.runtime!, status } };
      expect(isThreadWorking(active)).toBe(true);
      expect(isThreadWorking({ ...active, settledOverride: "settled" })).toBe(false);
      expect(isThreadWorking({ ...active, settledOverride: null })).toBe(true);
      expect(isThreadWorking({ ...active, settledOverride: "active" })).toBe(true);
    },
  );

  it.each(["monitor", "subagent", "background_task", "command"] as const)(
    "keeps only completion-holding %s background work",
    (kind) => {
      const waiting = {
        ...running,
        latestRun: completed,
        runtime: { ...running.runtime!, status: "idle" as const },
        pendingBackgroundTasks: [{ taskId: "background", kind }],
      };
      expect(isThreadWorking(waiting)).toBe(kind !== "command");
      expect(isThreadWorking({ ...waiting, settledOverride: "settled" })).toBe(false);
      expect(isThreadWorking({ ...waiting, pendingBackgroundTasks: [] })).toBe(false);
    },
  );

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { pendingSubagentRequest: "user_input" as const },
  ])("keeps input in Inbox and suppresses settled old input: %s", (request) => {
    const waiting = {
      ...running,
      ...request,
      runtime: { ...running.runtime!, status: "waiting" as const },
    };
    expect(isThreadWorking(waiting)).toBe(false);
    expect(isThreadAwaitingInput(waiting)).toBe(true);
    expect(isThreadAwaitingInput({ ...waiting, settledOverride: "settled" })).toBe(false);
  });

  it("counts scoped thread identities, without counting an entry twice or merging environments", () => {
    const remote = { ...running, environmentId: EnvironmentId.make("remote") };
    expect([
      ...workingThreadKeys([
        running,
        running,
        remote,
        { ...running, id: ThreadId.make("old"), settledOverride: "settled" },
      ]),
    ]).toEqual([`${environmentId}:run`, "remote:run"]);
  });
});

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});
