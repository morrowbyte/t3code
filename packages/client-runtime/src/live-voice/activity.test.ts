import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { activeVoiceToolActivities } from "./activity.ts";

const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};

function command(): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  return {
    id: TurnItemId.make("command"),
    threadId: threadRef.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-28T10:00:00.000Z"),
    type: "command_execution",
    input: "# Intent: Inspect the selected report\ncat private-path",
    output: "private output",
  };
}

function projected(item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem {
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}

it("uses public work-log intent while keeping opaque input, output and reasoning out of activity bubbles", () => {
  const unknown: OrchestrationV2TurnItem = {
    ...command(),
    id: TurnItemId.make("opaque"),
    type: "dynamic_tool",
    toolName: "mcp__unknown__execute",
    input: { description: "Invented activity", payload: "private payload" },
  };
  const reasoning: OrchestrationV2TurnItem = {
    ...command(),
    id: TurnItemId.make("reasoning"),
    type: "reasoning",
    text: "private reasoning",
    streaming: false,
  };
  const rows = [projected(command()), projected(unknown), projected(reasoning)];
  const activities = activeVoiceToolActivities(rows, threadRef);
  expect(activities).toEqual([
    { id: "command", label: "Inspect the selected report", status: "running" },
    { id: "opaque", label: "Using a tool", status: "running" },
  ]);
  expect(JSON.stringify(activities)).not.toMatch(/private|Invented|mcp__/u);
});

it("only presents current local executable work and removes it when the persisted status settles", () => {
  const current = projected(command());
  const otherThread = ThreadId.make("other-thread");
  const excluded = [
    { ...current, visibility: "inherited" as const },
    { ...current, sourceThreadId: otherThread },
    { ...current, item: { ...command(), threadId: otherThread } },
    { ...current, item: { ...command(), toolNonExecutionKind: "blocked" } },
    ...(["completed", "cancelled", "interrupted", "failed"] as const).map((status) => ({
      ...current,
      item: { ...command(), status },
    })),
  ];
  expect(activeVoiceToolActivities(excluded, threadRef)).toEqual([]);
  for (const status of ["pending", "running", "waiting"] as const) {
    expect(
      activeVoiceToolActivities([{ ...current, item: { ...command(), status } }], threadRef),
    ).toEqual([{ id: "command", label: "Inspect the selected report", status }]);
  }
});
