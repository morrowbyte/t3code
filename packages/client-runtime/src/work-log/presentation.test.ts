import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  resolveWorkEntryToolPresentation,
  workEntryIntentLabel,
  workEntryExplicitIntentLabel,
  precedingPublicActivity,
  workEntryExecutionStatus,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./presentation.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    exitCode: 0,
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(workEntryIndicatesToolSuccess(entry)).toBe(!failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T3-code.t3_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
    const childFailure = {
      ...entry,
      label: "T3-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
    expect(workEntryIndicatesToolSuccess(childFailure)).toBe(true);
  });
  it.each([
    "mcp__t3-code__preview_click",
    "mcp__t3_code__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "t3-code · preview_click completed",
    "t3_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t3-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t3-code.unknown_tool",
      "t3-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("runtime tool intent", () => {
  it("uses a newly registered tool's call title without interpreting opaque arguments", () => {
    const input = Object.freeze({
      capsule: "42",
      description: "Delete everything",
      title: "Unrelated argument",
    });
    const item = {
      ...commandItem(),
      type: "dynamic_tool" as const,
      toolName: "mcp__new_runtime__transduce",
      title: "Compare the selected shipment quotes",
      input,
    };
    const entry: WorkLogPresentationEntry = {
      id: "runtime",
      createdAt: "",
      label: item.toolName,
      tone: "tool",
      itemType: "dynamic_tool",
      structuredPayload: item,
    };
    expect(workEntryIntentLabel(entry)).toBe("Compare the selected shipment quotes");
    expect(workEntryIntentLabel({ ...entry, structuredPayload: { ...item, title: null } })).toBe(
      "Tool: mcp__new_runtime__transduce",
    );
    expect(item.input).toBe(input);
    expect(item.input.description).toBe("Delete everything");
    expect(workEntryExecutionStatus(entry)).toBe("Completed");
    expect(
      workEntryExecutionStatus({ ...entry, structuredPayload: { ...item, status: "running" } }),
    ).toBe("Running");
    expect(
      workEntryExecutionStatus({ ...entry, structuredPayload: { ...item, status: "failed" } }),
    ).toBe("Failed");
  });
  it("keeps a call intent independent of command outcome and preserves raw input", () => {
    const input = "# Intent: Inspect validation results\npython3 - <<'PY'\nprint('original')\nPY\n";
    const item = commandItem({ input, exitCode: 2 });
    const entry: WorkLogPresentationEntry = {
      id: "script",
      createdAt: "",
      label: "Command",
      tone: "tool",
      command: input,
      structuredPayload: item,
    };
    expect(workEntryIntentLabel(entry)).toBe("Inspect validation results");
    expect(workEntryExecutionStatus(entry)).toBe("Failed · exit 2");
    expect(item.input).toBe(input);
  });
});

it("keeps execution status independent of intent and quoted error text", () => {
  const item = commandItem({
    title: "Investigate failed checks",
    output: "command not found is the string being inspected",
    exitCode: 0,
  });
  const entry: WorkLogPresentationEntry = {
    id: "status",
    createdAt: "",
    label: "Failed checks",
    tone: "tool",
    structuredPayload: item,
  };
  expect(workEntryExecutionStatus(entry)).toBe("Completed");
  expect(workEntryIntentLabel(entry)).toBe("Investigate failed checks");
});

describe("public activity context", () => {
  it("uses current public progress immediately and never crosses a round, steer or attempt", () => {
    const labels = precedingPublicActivity(
      [
        {
          kind: "message",
          role: "assistant",
          text: "Inspect Tibo's OpenAI posts",
          runId: "r1",
          attemptId: "a1",
        },
        { kind: "work", id: "first", runId: "r1", attemptId: "a1" },
        { kind: "work", id: "fast-completed", runId: "r1", attemptId: "a1" },
        { kind: "work", id: "retry", runId: "r1", attemptId: "a2" },
        {
          kind: "message",
          role: "assistant",
          text: "Compare the linked announcements",
          runId: "r1",
          attemptId: "a2",
        },
        { kind: "work", id: "next-step", runId: "r1", attemptId: "a2" },
        { kind: "message", role: "user", text: "Now inspect pricing", runId: "r1" },
        { kind: "work", id: "after-steer", runId: "r1", attemptId: "a2" },
        { kind: "work", id: "new-round", runId: "r2" },
      ] as const,
      (entry) => entry,
    );
    expect([...labels]).toEqual([
      ["first", "Inspect Tibo's OpenAI posts"],
      ["fast-completed", "Inspect Tibo's OpenAI posts"],
      ["next-step", "Compare the linked announcements"],
    ]);
  });

  it("bounds public text without reading reasoning, outputs or opaque arguments", () => {
    const entries = [
      { kind: "message", role: "assistant", text: "  Inspect\n" + "x".repeat(1000), runId: null },
      { kind: "work", id: "unknown", runId: null },
    ] as const;
    const labels = precedingPublicActivity(entries, (entry) => entry);
    expect(labels.get("unknown")).toHaveLength(240);
    expect(entries[0].text).toContain("\n");
  });

  it("prefers concrete native metadata over generic command capabilities", () => {
    const item = commandItem({
      title: "Extract Tibo’s OpenAI X posts",
      input: "python3 - <<'PY'\nopaque()\nPY",
    });
    expect(
      workEntryExplicitIntentLabel({
        id: "call",
        createdAt: "",
        label: "",
        tone: "tool",
        structuredPayload: item,
      }),
    ).toBe(item.title);
    expect(
      workEntryExplicitIntentLabel({
        id: "call",
        createdAt: "",
        label: "",
        tone: "tool",
        structuredPayload: { ...item, title: "Run shell commands" },
      }),
    ).toBeUndefined();
  });
});

it("presents a translated authored label only while its original intent is unchanged", () => {
  const input = 'bash -lc "# Intent: Installierte Version prüfen\nprintf version"';
  const structuredPayload = commandItem({
    input,
    title: "Check Installed Version",
    activityPresentation: {
      title: "Check installed version",
      language: "en",
      sourceTitle: "Installierte Version prüfen",
    },
  });
  const entry: WorkLogPresentationEntry = {
    id: "localized",
    createdAt: "2026-10-28T00:00:00Z",
    label: "Command",
    tone: "tool",
    itemType: "command_execution",
    structuredPayload,
  };
  expect(workEntryExplicitIntentLabel(entry)).toBe("Check installed version");
  expect(workEntryIntentLabel(entry)).toBe("Check installed version");
  const updated = {
    ...entry,
    structuredPayload: {
      ...structuredPayload,
      input: "# Intent: Andere Version prüfen\nprintf other",
    },
  };
  expect(workEntryExplicitIntentLabel(updated)).toBe("Andere Version prüfen");
  expect(workEntryIntentLabel(updated)).toBe("Andere Version prüfen");
  expect(structuredPayload.input).toBe(input);
});
