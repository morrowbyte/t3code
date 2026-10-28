import { MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveMessagesTimelineRows,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  liveWorkEntryLabel,
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";

describe("long active tool groups", () => {
  it.each([false, true])(
    "preserves chronological order and the latest activity, expanded=%s",
    (expanded) => {
      const runId = RunId.make("long-active-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `work-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `work-${index}`,
          createdAt,
          runId,
          label: `Tool ${index}`,
          tone: index % 2 === 0 ? ("thinking" as const) : ("tool" as const),
          itemType: index % 2 === 0 ? ("reasoning" as const) : ("command_execution" as const),
          ...(index % 2 === 0 ? { detail: `Thought ${index}` } : {}),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(expanded ? ["work-group:work-entry-0"] : []),
      });
      const live = rows.find((row) => row.kind === "work-live");
      expect(live).toBeDefined();
      expect(live?.entry.id).toBe("work-999");
      expect(live && liveWorkEntryLabel(live.entry, undefined, live.active)).toContain("999");
      expect(live?.thought?.id).toBe("work-998");
      expect(live?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(live?.groupId).toBe("work-group:work-entry-0");
      const details = rows.filter((row) => row.kind === "work");
      expect(details).toHaveLength(expanded ? 1 : 0);
      if (expanded) {
        expect(details[0]?.groupedEntries).toEqual(live?.groupedEntries);
      }
    },
  );
});

it.each(["command_execution", "dynamic_tool"] as const)(
  "shows group context before enrichment and concrete %s intent in individual rows",
  (type) => {
    const runId = RunId.make("intent-run");
    const at = "2026-10-23T20:05:50.263Z";
    const input = type === "command_execution" ? "python3 - <<'PY'\nopaque()\nPY" : { capsule: 42 };
    const item = {
      id: TurnItemId.make("runtime-call"),
      threadId: ThreadId.make("fixture"),
      runId,
      type,
      input,
      toolName: "mcp__newly_registered__inspect_capsule",
      title: null,
      status: "running",
    } as unknown as import("@t3tools/contracts").OrchestrationV2TurnItem;
    const work = {
      id: "call",
      kind: "work" as const,
      createdAt: at,
      entry: {
        id: "call",
        createdAt: at,
        runId,
        label: "Run shell commands",
        tone: "tool" as const,
        itemType: type,
        toolLifecycleStatus: "inProgress" as const,
        structuredPayload: item,
      },
    };
    const commentary = {
      id: "progress",
      kind: "message" as const,
      createdAt: at,
      message: {
        id: MessageId.make("progress"),
        role: "assistant" as const,
        text: "Inspect Tibo's OpenAI posts from 23 October",
        runId,
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    };
    const renderRows = (timelineEntries: import("../../session-logic").TimelineEntry[]) =>
      deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(["work-group:call"]),
      });
    const before = renderRows([commentary, work]);
    const changedCommentary = {
      ...commentary,
      message: {
        ...commentary.message,
        text: "Compare the selected announcements",
        streaming: true,
      },
    };
    const changedRows = renderRows([changedCommentary, work]);
    const stable = computeStableMessagesTimelineRows(before, { byId: new Map(), result: [] });
    const updated = computeStableMessagesTimelineRows(changedRows, stable);
    expect(updated.result.find((row) => row.kind === "work-live")).toMatchObject({
      activityIntent: changedCommentary.message.text,
    });
    const context = {
      isWorking: true,
      runningRunId: runId,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const streamingCommentary = {
      ...commentary,
      message: { ...commentary.message, streaming: true },
    };
    const projection = deriveMessagesTimelineRowsWithState({
      ...context,
      timelineEntries: [streamingCommentary, work],
    });
    const streamed = deriveMessagesTimelineRowsWithState(
      { ...context, timelineEntries: [changedCommentary, work] },
      projection,
    );
    expect(streamed.rows.find((row) => row.kind === "work-live")).toMatchObject({
      activityIntent: changedCommentary.message.text,
    });

    expect(before.find((row) => row.kind === "work-live")).toMatchObject({
      activityIntent: commentary.message.text,
    });
    expect(before.find((row) => row.kind === "work")?.groupedEntries[0]?.structuredPayload).toBe(
      item,
    );
    const titled = {
      ...work,
      entry: {
        ...work.entry,
        structuredPayload: { ...item, title: "Extract the selected OpenAI posts" },
      },
    };
    const after = renderRows([commentary, titled]);
    expect(after.find((row) => row.kind === "work-live")).toMatchObject({
      activityIntent: commentary.message.text,
    });
    expect(liveWorkEntryLabel(titled.entry, undefined, true)).toBe(
      "Extract the selected OpenAI posts",
    );
    expect(workEntryDisplayLabel(titled.entry, undefined)).toBe(
      "Extract the selected OpenAI posts",
    );
    expect(
      "input" in titled.entry.structuredPayload ? titled.entry.structuredPayload.input : undefined,
    ).toBe(input);
    const source =
      type === "command_execution"
        ? "# Intent: Inspect recording permission preferences\npython3 inspect.py"
        : { code: "// Intent: Inspect recording permission preferences\nawait inspect();" };
    const initial = {
      ...work.entry,
      structuredPayload: {
        ...item,
        input: source,
        title: "Run shell commands",
      } as import("@t3tools/contracts").OrchestrationV2TurnItem,
    };
    expect(liveWorkEntryLabel(initial, undefined, true)).toBe(
      "Inspect recording permission preferences",
    );
    expect(workEntryDisplayLabel(initial, undefined)).toBe(
      "Inspect recording permission preferences",
    );
    expect("input" in initial.structuredPayload && initial.structuredPayload.input).toBe(source);
    const nextRound = { ...work, entry: { ...work.entry, runId: RunId.make("next-run") } };
    expect(
      renderRows([commentary, nextRound]).some(
        (row) => row.kind === "work-live" && row.activityIntent,
      ),
    ).toBe(false);
  },
);
