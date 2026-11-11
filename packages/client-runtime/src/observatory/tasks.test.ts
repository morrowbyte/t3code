import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  NodeId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { v2Now, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { observatoryTaskStatus, presentTaskInterruption, projectObservatoryTask } from "./tasks.ts";
import { observatoryKey, type ObservatoryNativeDetails, type ObservatoryNode } from "./native.ts";

const ref = { environmentId: EnvironmentId.make("one"), threadId: v2ThreadShell.id };
const node: ObservatoryNode = {
  key: observatoryKey(ref),
  ref,
  title: "Ship task view",
  nativeStatus: "completed",
  runId: null,
  parentKey: null,
  shell: { ...v2ThreadShell, status: "completed" },
};

describe("agent task status", () => {
  it("keeps missing interruption reasons honest and errors scoped to the current task run", () => {
    const goal = { objective: "Ship task view", status: "blocked" as const };
    expect(presentTaskInterruption(goal)?.reason).toBe("No reason provided with this status.");
    expect(presentTaskInterruption({ ...goal, status: "paused" })?.nextStep).toContain(
      "/goal resume",
    );
    expect(presentTaskInterruption({ ...goal, status: "budget_limited" })?.reason).toContain(
      "token budget",
    );
    const runId = RunId.make("current");
    const blocked = { ...node, runId, shell: { ...node.shell, goal } };
    const error = {
      type: "error",
      threadId: ref.threadId,
      runId,
      failure: { message: "Current provider failure" },
    };
    const update = {
      type: "assistant_message",
      threadId: ref.threadId,
      runId,
      text: "Waiting for the requested workspace path.",
    };
    const detail = {
      projection: {
        runtimeRequests: [],
        runs: [],
        messages: [],
        turnItems: [
          error,
          { ...error, runId: RunId.make("older"), failure: { message: "Old failure" } },
          { ...error, threadId: ThreadId.make("child"), failure: { message: "Child failure" } },
          update,
          { ...update, threadId: ThreadId.make("child"), text: "Unrelated child update" },
          { ...update, runId: RunId.make("older"), text: "Obsolete update" },
        ],
      },
      plans: [],
      steps: [],
      completedSteps: [],
      nextSteps: [],
      subagents: [],
      ownedNodeIds: new Set(),
    } as unknown as ObservatoryNativeDetails;
    const task = projectObservatoryTask(blocked, [blocked], detail);
    expect(task.lastError).toBe("Current provider failure");
    expect(task.lastUpdate).toBe(update.text);
    expect(task.interruption?.reason).toBe("No reason provided with this status.");
    expect(projectObservatoryTask(blocked, [blocked], null).lastError).toBeNull();
    expect(projectObservatoryTask(blocked, [blocked], null).lastUpdate).toBeNull();
    expect(presentTaskInterruption({ ...goal, status: "complete" })).toBeNull();
  });

  it.each([
    { status: "running" as const, expected: "working" },
    { status: "completed" as const, expected: "open" },
    { status: "idle" as const, expected: "open" },
    { status: "failed" as const, expected: "blocked" },
  ])("maps $status without inventing completion", ({ status, expected }) => {
    expect(
      observatoryTaskStatus(
        { ...v2ThreadShell, status },
        {
          blockingRequest: false,
          pendingAgents: false,
        },
      ),
    ).toBe(expected);
  });

  it("requires goal completion and gives actual pending input and child work precedence", () => {
    const shell = {
      ...node.shell,
      goal: { objective: "Ship task view", status: "complete" as const },
    };
    expect(observatoryTaskStatus(shell, { blockingRequest: false, pendingAgents: false })).toBe(
      "complete",
    );
    expect(observatoryTaskStatus(shell, { blockingRequest: true, pendingAgents: true })).toBe(
      "waiting_user",
    );
    expect(observatoryTaskStatus(shell, { blockingRequest: false, pendingAgents: true })).toBe(
      "waiting_agent",
    );
    expect(
      observatoryTaskStatus(
        { ...shell, goal: { ...shell.goal, status: "paused" } },
        {
          blockingRequest: false,
          pendingAgents: false,
        },
      ),
    ).toBe("paused");
    const snoozed = {
      ...node.shell,
      snoozedUntil: DateTime.makeUnsafe("2026-06-01T10:00:00.000Z"),
    };
    for (const [at, expected] of [
      ["2026-06-01T09:59:59.000Z", "paused"],
      ["2026-06-01T10:00:00.000Z", "open"],
    ]) {
      expect(
        observatoryTaskStatus(snoozed, {
          blockingRequest: false,
          pendingAgents: false,
          nowMs: Date.parse(at!),
        }),
      ).toBe(expected);
      const snoozedNode = { ...node, shell: snoozed };
      expect(
        projectObservatoryTask(snoozedNode, [snoozedNode], null, Date.parse(at!)).interruption,
      ).toEqual(
        expected === "paused"
          ? {
              reason: "The thread is snoozed.",
              nextStep: "Use Wake now in the thread status controls to end the snooze.",
            }
          : null,
      );
    }
  });

  it("keeps identical thread IDs on different environments and missing plans separate", () => {
    const foreign = {
      ...node,
      key: "foreign",
      ref: { ...ref, environmentId: EnvironmentId.make("other") },
    };
    const childRef = { ...ref, threadId: ThreadId.make("child") };
    const child = {
      ...node,
      key: observatoryKey(childRef),
      ref: childRef,
      parentKey: foreign.key,
      shell: { ...node.shell, status: "running" as const },
    };
    const task = projectObservatoryTask(node, [node, foreign, child], null);
    expect(task.status).toBe("open");
    expect(task.dependencies).toEqual([]);
    expect(task.planStatus).toBe("loading");
    expect(task.objective).toBeNull();
    const foreignTask = projectObservatoryTask(foreign, [node, foreign, child], null);
    expect(foreignTask.status).toBe("waiting_agent");
    expect(foreignTask.dependencies[0]?.ref).toEqual(childRef);
  });

  it("distinguishes asynchronous questions, blocking input and internal tool requests", () => {
    const request = {
      id: RuntimeRequestId.make("input"),
      nodeId: NodeId.make("input-node"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: v2Now,
      resolvedAt: null,
    };
    // Only the fields consumed by task projection vary in this focused fixture.
    const detail = {
      projection: {
        runs: [{ id: RunId.make("run"), rootNodeId: NodeId.make("root") }],
        runtimeRequests: [request],
        turnItems: [],
        messages: [],
      },
      plans: [],
      steps: [],
      completedSteps: [],
      nextSteps: [],
      currentStep: null,
      subagents: [],
      ownedNodeIds: new Set([NodeId.make("root"), request.nodeId]),
    } as unknown as ObservatoryNativeDetails;
    const working = { ...node, shell: { ...node.shell, status: "running" as const } };
    const task = projectObservatoryTask(working, [working], detail);
    expect(task.status).toBe("working");
    expect(task.request).toMatchObject({ id: request.id, blocking: false });
    expect(task.planStatus).toBe("missing");
    const blocking = {
      ...detail,
      projection: {
        ...detail.projection,
        runtimeRequests: [
          {
            ...request,
            responseCapability: {
              type: "live" as const,
              providerSessionId: ProviderSessionId.make("session"),
            },
          },
        ],
      },
    } as ObservatoryNativeDetails;
    expect(projectObservatoryTask(working, [working], blocking).status).toBe("waiting_user");
    for (const kind of ["auth_refresh", "dynamic_tool_call"] as const) {
      const internal = {
        ...detail,
        projection: { ...detail.projection, runtimeRequests: [{ ...request, kind }] },
      };
      expect(projectObservatoryTask(working, [working], internal).request).toBeNull();
    }
    const childRequest = {
      ...detail,
      projection: {
        ...detail.projection,
        runtimeRequests: [{ ...request, nodeId: NodeId.make("child-node") }],
      },
    };
    expect(projectObservatoryTask(working, [working], childRequest).request).toBeNull();
    const summary = {
      id: request.id,
      kind: request.kind,
      createdAt: v2Now,
      blocking: false,
    };
    const summarized = { ...working, shell: { ...working.shell, pendingRuntimeRequests: [summary] } };
    const resolved = {
      ...detail,
      projection: {
        ...detail.projection,
        runtimeRequests: [{ ...request, status: "resolved" as const }],
      },
    };
    expect(projectObservatoryTask(summarized, [summarized], resolved).request).toBeNull();
    const cleared = { ...working, shell: { ...working.shell, pendingRuntimeRequests: [] } };
    expect(projectObservatoryTask(cleared, [cleared], detail).request).toBeNull();
    expect(projectObservatoryTask(summarized, [summarized], childRequest).request).toBeNull();
    expect(projectObservatoryTask(summarized, [summarized], null).request).toMatchObject({
      id: request.id,
      blocking: false,
    });
  });

  it.each(["secret_request", "link_request"] as const)(
    "merges %s decisions with runtime input without reviving resolved cards",
    (type) => {
      const runId = RunId.make("card-run");
      const nodeId = NodeId.make("card-node");
      const base = {
        id: TurnItemId.make("decision-card"),
        threadId: ref.threadId,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting" as const,
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        reason: "Continue the task",
        label: "Task access",
      };
      const card: OrchestrationV2TurnItem =
        type === "secret_request"
          ? { ...base, type, secretStatus: "pending" }
          : { ...base, type, linkStatus: "pending" };
      const summary = {
        id: RuntimeRequestId.make(card.id),
        kind: "user_input" as const,
        createdAt: v2Now,
        blocking: true,
      };
      const complete = {
        ...node,
        shell: {
          ...node.shell,
          goal: { objective: "Task access", status: "complete" as const },
          pendingRuntimeRequests: [summary],
        },
      };
      const runtime = {
        id: RuntimeRequestId.make("async-question"),
        nodeId,
        kind: "user_input" as const,
        status: "pending" as const,
        responseCapability: { type: "message" as const },
      };
      const detail = {
        projection: {
          runs: [{ id: runId, status: "running" }],
          runtimeRequests: [runtime],
          turnItems: [card],
          messages: [],
        },
        plans: [],
        steps: [],
        completedSteps: [],
        nextSteps: [],
        subagents: [],
        ownedNodeIds: new Set([nodeId]),
      } as unknown as ObservatoryNativeDetails;
      const expected = { id: summary.id, label: card.label, blocking: true };
      const task = projectObservatoryTask(complete, [complete], detail);
      expect(task.request).toEqual(expected);
      expect(task.status).toBe("waiting_user");
      expect(projectObservatoryTask(complete, [complete], null).request).toMatchObject({
        id: summary.id,
        blocking: true,
      });
      const missingHistory = {
        ...detail,
        projection: { ...detail.projection, turnItems: [], runtimeRequests: [] },
      };
      expect(projectObservatoryTask(complete, [complete], missingHistory).status).toBe(
        "waiting_user",
      );
      const missingRun = {
        ...detail,
        projection: { ...detail.projection, runs: [] },
      };
      expect(projectObservatoryTask(complete, [complete], missingRun).request).toEqual(expected);
      const legacy = {
        ...complete,
        shell: {
          ...complete.shell,
          pendingRuntimeRequests: undefined,
          pendingRuntimeRequest: summary,
        },
      };
      expect(projectObservatoryTask(legacy, [legacy], detail).request).toEqual(expected);
      expect(projectObservatoryTask(legacy, [legacy], missingHistory).status).toBe(
        "waiting_user",
      );
      const mixed = {
        ...complete,
        shell: {
          ...complete.shell,
          pendingRuntimeRequests: [
            { ...summary, id: runtime.id, blocking: false },
            summary,
          ],
        },
      };
      expect(projectObservatoryTask(mixed, [mixed], detail).request).toEqual(expected);
      const withoutCard = {
        ...mixed,
        shell: {
          ...mixed.shell,
          pendingRuntimeRequests: [mixed.shell.pendingRuntimeRequests[0]!],
        },
      };
      expect(projectObservatoryTask(withoutCard, [withoutCard], detail).request).toMatchObject({
        id: runtime.id,
        blocking: false,
      });
      for (const shell of [
        { ...complete.shell, pendingRuntimeRequests: [], pendingRuntimeRequest: summary },
        { ...complete.shell, settledOverride: "settled" as const },
      ]) {
        const resolved = { ...complete, shell };
        expect(projectObservatoryTask(resolved, [resolved], detail).request).toBeNull();
        expect(projectObservatoryTask(resolved, [resolved], detail).status).toBe("complete");
      }
      const answered = {
        ...detail,
        projection: {
          ...detail.projection,
          turnItems: [
            card.type === "secret_request"
              ? { ...card, secretStatus: "saved" as const }
              : { ...card, linkStatus: "linked" as const },
          ],
        },
      };
      expect(projectObservatoryTask(complete, [complete], answered).request).toBeNull();
      const ended = {
        ...detail,
        projection: {
          ...detail.projection,
          turnItems: [{ ...card, status: "completed" as const }],
        },
      };
      expect(projectObservatoryTask(complete, [complete], ended).request).toBeNull();
      for (const outOfScope of [
        { ...card, threadId: ThreadId.make("other-thread") },
        { ...card, nodeId: NodeId.make("other-node") },
      ]) {
        const scoped = {
          ...detail,
          projection: { ...detail.projection, turnItems: [outOfScope] },
        };
        const withoutSummary = {
          ...legacy,
          shell: { ...legacy.shell, pendingRuntimeRequest: null },
        };
        expect(
          projectObservatoryTask(withoutSummary, [withoutSummary], scoped).request,
        ).toMatchObject({ id: runtime.id, blocking: false });
      }
    },
  );
});
