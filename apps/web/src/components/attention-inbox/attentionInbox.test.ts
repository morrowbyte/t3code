import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { attentionCoverageLabel, deriveAttentionInbox } from "./attentionInbox.logic";

const environmentId = EnvironmentId.make("nixy");
const now = DateTime.makeUnsafe("2026-10-17T09:30:00.000Z");
const runId = RunId.make("run-result");
const request = {
  id: RuntimeRequestId.make("request-answer"),
  kind: "user_input" as const,
  createdAt: now,
};
const base = makeThreadFixture().source;
const shell = (patch: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell => ({
  ...base,
  id: ThreadId.make("source-thread"),
  title: "Review the plan",
  status: "running",
  pendingRuntimeRequest: null,
  latestRunId: runId,
  latestRunCompletedAt: null,
  activeRunId: null,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  ...patch,
});

describe("canonical attention inbox", () => {
  it("uses source request IDs and separates questions, approvals and auth warnings", () => {
    const threads = [
      shell({ pendingRuntimeRequest: request }),
      shell({
        id: ThreadId.make("approval"),
        pendingRuntimeRequest: {
          ...request,
          id: RuntimeRequestId.make("approval-command"),
          kind: "command",
        },
      }),
      shell({
        id: ThreadId.make("auth"),
        pendingRuntimeRequest: { ...request, kind: "auth_refresh" },
      }),
      shell({
        id: ThreadId.make("tool"),
        pendingRuntimeRequest: { ...request, kind: "dynamic_tool_call" },
      }),
    ];
    const model = deriveAttentionInbox(environmentId, threads);
    expect(model.counts).toEqual({ questions: 1, approvals: 1, completed: 0, warnings: 1 });
    expect(model.entries[0]?.id).toContain(request.id);
    expect(model.entries[0]?.threadRef).toEqual({ environmentId, threadId: threads[0]!.id });
    expect(model.entries.map((entry) => entry.title)).toContain("Authentication required");
    const renamed = deriveAttentionInbox(environmentId, [
      shell({ title: "New title", updatedAt: now, pendingRuntimeRequest: request }),
    ]);
    expect(renamed.entries[0]?.id).toBe(model.entries[0]?.id);
  });

  it("removes an answered question only when the canonical pending request changes", () => {
    const before = shell({ pendingRuntimeRequest: request });
    expect(deriveAttentionInbox(environmentId, [before]).counts.questions).toBe(1);
    expect(
      deriveAttentionInbox(environmentId, [{ ...before, pendingRuntimeRequest: null }]).counts
        .questions,
    ).toBe(0);
    const next = { ...request, id: RuntimeRequestId.make("next-question") };
    expect(
      deriveAttentionInbox(environmentId, [shell({ pendingRuntimeRequest: next })]).entries[0]?.id,
    ).not.toBe(deriveAttentionInbox(environmentId, [before]).entries[0]?.id);
    expect(deriveAttentionInbox(environmentId, [{ ...before }]).entries).toEqual(
      deriveAttentionInbox(environmentId, [before]).entries,
    );
  });

  it("requires an explicit completed-run timestamp and respects canonical settlement", () => {
    const completed = shell({ status: "completed", latestRunCompletedAt: now });
    expect(deriveAttentionInbox(environmentId, [completed]).entries[0]).toMatchObject({
      category: "completed",
      occurredAt: DateTime.formatIso(now),
    });
    expect(
      deriveAttentionInbox(environmentId, [{ ...completed, status: "idle" }]).counts.completed,
    ).toBe(1);
    for (const patch of [
      { settledOverride: "settled" as const },
      { activeRunId: runId },
      { activityRunStatus: "running" as const },
      { pendingBackgroundTasks: [{ kind: "subagent" as const, taskId: "child-work" }] },
      { pendingRuntimeRequest: request },
      { status: "running" as const },
      { latestRunId: null },
      { latestRunCompletedAt: null },
    ]) {
      expect(
        deriveAttentionInbox(environmentId, [{ ...completed, ...patch }]).counts.completed,
      ).toBe(0);
    }
    expect(
      deriveAttentionInbox(environmentId, [
        shell({ pendingRuntimeRequest: request, settledOverride: "settled" }),
      ]).counts.questions,
    ).toBe(1);
  });

  it("reports older-server completion coverage without inferring completion from updatedAt", () => {
    const completed = shell({ status: "completed", latestRunCompletedAt: now });
    const { latestRunCompletedAt: _timestamp, ...olderServer } = completed;
    const model = deriveAttentionInbox(environmentId, [olderServer]);
    expect(model.counts.completed).toBe(0);
    expect(model.completionTimeUnavailable).toBe(1);
  });

  it("shows actual failure or usage-limit state and clears warnings when the run recovers", () => {
    const failed = shell({
      status: "failed",
      lastError: "Connection failed",
      latestRunCompletedAt: now,
    });
    expect(deriveAttentionInbox(environmentId, [failed]).entries[0]).toMatchObject({
      category: "warnings",
      description: "Connection failed",
    });
    expect(
      deriveAttentionInbox(environmentId, [{ ...failed, lastErrorClass: "usage_limit" }]).entries[0]
        ?.title,
    ).toBe("Usage limit reached");
    expect(
      deriveAttentionInbox(environmentId, [{ ...failed, status: "running" }]).counts.warnings,
    ).toBe(0);
    expect(deriveAttentionInbox(environmentId, [shell()]).entries).toEqual([]);
  });

  it("excludes archived/deleted threads, includes the actual child source, and scopes identical IDs by environment", () => {
    const pending = shell({ pendingRuntimeRequest: request });
    const model = deriveAttentionInbox(environmentId, [
      { ...pending, archivedAt: now },
      { ...pending, deletedAt: now },
      {
        ...pending,
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      },
    ]);
    expect(model.loadedThreads).toBe(1);
    expect(model.entries).toHaveLength(1);
    const other = deriveAttentionInbox(EnvironmentId.make("hephaestus"), [pending]);
    expect(other.entries[0]?.id).not.toBe(model.entries[0]?.id);
    expect(other.entries[0]?.threadRef.environmentId).toBe("hephaestus");
  });

  it("labels cached, reconnecting and unavailable coverage without claiming current empty state", () => {
    expect(attentionCoverageLabel("live", true)).toContain("Live");
    expect(attentionCoverageLabel("cached", true)).toContain("out of date");
    expect(attentionCoverageLabel("synchronizing", true)).toContain("synchronizing");
    expect(attentionCoverageLabel("empty", false)).toContain("not loaded");
  });
});
