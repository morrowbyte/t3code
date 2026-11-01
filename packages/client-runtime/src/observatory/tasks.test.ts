import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  NodeId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { v2Now, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { observatoryTaskStatus, projectObservatoryTask } from "./tasks.ts";
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
  });
});
