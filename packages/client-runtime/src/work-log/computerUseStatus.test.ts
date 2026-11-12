import {
  NodeId,
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { computerUseProjectionItems, deriveComputerUseStatus } from "./computerUseStatus.ts";

const runId = RunId.make("cu-run");
const at = (seconds: number) =>
  DateTime.makeUnsafe(`2026-11-11T22:00:${String(seconds).padStart(2, "0")}Z`);

function tool(
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
): Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> {
  return {
    id: TurnItemId.make("sky-action"),
    threadId: ThreadId.make("cu-thread"),
    runId,
    nodeId: NodeId.make("cu-node"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: "Read editor window",
    startedAt: at(1),
    completedAt: null,
    updatedAt: at(2),
    type: "dynamic_tool",
    toolName: "node_repl.js",
    toolSurface: "computer",
    toolSource: { key: "editor", name: "Editor", kind: "computer" },
    input: { code: "await sky.get_app_state(app);" },
    ...overrides,
  };
}

const derive = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  deriveComputerUseStatus({ items, runId, isWorking: true });

describe("deriveComputerUseStatus", () => {
  it("keeps native Stop events while excluding superseded attempts and other runs", () => {
    const current = tool();
    const oldRoot = NodeId.make("old-root");
    const oldNode = NodeId.make("old-node");
    const old = tool({ id: TurnItemId.make("old-action"), nodeId: oldNode });
    const { toolName: _name, input: _input, ...base } = current;
    const stop = {
      ...base,
      id: TurnItemId.make("stop-current"),
      nodeId: null,
      type: "run_interrupt_request" as const,
      message: "Stop",
      updatedAt: at(5),
    };
    const items = computerUseProjectionItems(
      {
        turnItems: [old, current, stop, tool({ runId: RunId.make("other-run") })],
        attempts: [{ runId, rootNodeId: oldRoot, status: "superseded" }],
        nodes: [{ id: oldNode, rootNodeId: oldRoot, parentNodeId: oldRoot }],
      },
      runId,
    );
    expect(items).toEqual([current, stop]);
    expect(derive(items)?.phase).toBe("Stopping…");
  });
  it("suspends active claims while the current connection is not synchronized", () => {
    expect(
      deriveComputerUseStatus({
        items: [tool()],
        runId,
        isWorking: true,
        confirmed: false,
      }),
    ).toMatchObject({
      phase: "Activity unconfirmed",
      target: null,
      action: null,
      live: false,
      startedAt: null,
    });
  });

  it("uses lifecycle event time after parallel calls finish rather than start order", () => {
    const first = tool({
      id: TurnItemId.make("first"),
      status: "failed",
      updatedAt: at(8),
      completedAt: at(8),
    });
    const second = tool({
      id: TurnItemId.make("second"),
      ordinal: 2,
      status: "completed",
      updatedAt: at(5),
      completedAt: at(5),
    });
    expect(derive([first, second])).toMatchObject({
      phase: "Tool failed",
      lastEventAt: DateTime.toEpochMillis(at(8)),
    });
  });

  it("does not attribute unrelated approvals or intervening tool results to a CU app", () => {
    const running = tool();
    const { toolName: _name, input: _input, ...base } = tool();
    const approval = {
      ...base,
      id: TurnItemId.make("approval"),
      type: "approval_request" as const,
      ordinal: 3,
      status: "pending" as const,
      nodeId: NodeId.make("shell-node"),
      requestId: RuntimeRequestId.make("shell-approval"),
      requestKind: "command" as const,
      updatedAt: at(4),
    };
    expect(
      deriveComputerUseStatus({
        items: [running, approval],
        runId,
        isWorking: true,
      })?.phase,
    ).toBe("Tool running");
    expect(
      deriveComputerUseStatus({
        items: [running, { ...approval, parentItemId: running.id }],
        runId,
        isWorking: true,
      })?.phase,
    ).toBe("Waiting for approval");
    expect(
      deriveComputerUseStatus({
        items: [
          running,
          {
            ...approval,
            id: TurnItemId.make("cu-approval"),
            parentItemId: running.id,
          },
          { ...approval, updatedAt: at(5) },
        ],
        runId,
        isWorking: true,
      })?.phase,
    ).toBe("Waiting for approval");
    const nativeItemRef = {
      driver: ProviderDriverKind.make("codex"),
      nativeId: "sky-action",
      strength: "strong" as const,
    };
    expect(
      deriveComputerUseStatus({
        items: [
          { ...running, nativeItemRef },
          { ...approval, nativeItemRef },
        ],
        runId,
        isWorking: true,
      })?.phase,
    ).toBe("Waiting for approval");
    const reasoning = {
      ...base,
      id: TurnItemId.make("later-thinking"),
      type: "reasoning" as const,
      ordinal: 4,
      startedAt: at(6),
      updatedAt: at(7),
      text: "Checking a shell result",
      streaming: true,
    };
    expect(
      derive([
        tool({ status: "completed", completedAt: at(3), updatedAt: at(3) }),
        tool({
          id: TurnItemId.make("shell"),
          ordinal: 2,
          toolName: "filesystem.read",
          toolSurface: undefined,
          toolSource: undefined,
          status: "completed",
          updatedAt: at(5),
        }),
        reasoning,
      ]),
    ).toBeNull();
  });
  it.each([
    ["pending", "Waiting to start"],
    ["running", "Tool running"],
    ["waiting", "Waiting for tool"],
    ["completed", "Tool finished"],
    ["failed", "Tool failed"],
    ["cancelled", "Tool stopped"],
    ["interrupted", "Tool stopped"],
  ] as const)(
    "uses the explicit %s lifecycle without guessing actions from code",
    (status, phase) => {
      const state = derive([tool({ status, completedAt: at(3) })]);
      expect(state?.phase).toBe(phase);
      expect(state?.target).toBe("Editor");
      expect(state?.action).toBe("Read editor window");
      expect(state?.lastEventAt).toBe(DateTime.toEpochMillis(at(2)));
      expect(state?.live).toBe(["pending", "running", "waiting"].includes(status));
      if (status !== "running") expect(state?.startedAt).toBeNull();
    },
  );

  it("only shows processing with a subsequent live reasoning event and drops unrelated work", () => {
    const completed = tool({ status: "completed", completedAt: at(3) });
    expect(derive([completed])?.phase).toBe("Tool finished");
    const {
      toolName: _tool,
      input: _input,
      toolSource: _source,
      toolSurface: _surface,
      ...base
    } = tool();
    const reasoning = {
      ...base,
      id: TurnItemId.make("reasoning"),
      type: "reasoning" as const,
      startedAt: at(4),
      updatedAt: at(5),
      text: "Inspecting the result",
      streaming: true,
    };
    expect(derive([completed, reasoning])).toMatchObject({
      phase: "Processing result",
      startedAt: DateTime.toEpochMillis(at(4)),
      lastEventAt: DateTime.toEpochMillis(at(5)),
    });
    expect(derive([completed, { ...reasoning, streaming: false, status: "completed" }])).toBeNull();
    expect(
      derive([
        completed,
        tool({
          id: TurnItemId.make("other"),
          ordinal: 2,
          updatedAt: at(4),
          toolName: "filesystem.read",
          toolSurface: undefined,
          toolSource: undefined,
        }),
      ]),
    ).toBeNull();
  });

  it("keeps concurrent live CU visible and clears on explicit stop, terminal run, and a new run", () => {
    const running = tool();
    const completed = tool({ id: TurnItemId.make("other-capture"), status: "completed" });
    expect(derive([running, completed])?.phase).toBe("Tool running");
    const { toolName: _tool, input: _input, ...base } = running;
    const stop = {
      ...base,
      id: TurnItemId.make("stop"),
      type: "run_interrupt_request" as const,
      status: "completed" as const,
      message: "Stop",
      startedAt: at(4),
      completedAt: at(4),
      updatedAt: at(4),
    };
    expect(derive([running, stop])).toMatchObject({
      phase: "Stopping…",
      startedAt: DateTime.toEpochMillis(at(4)),
    });
    expect(derive([running, { ...stop, type: "run_interrupt_result" }])).toBeNull();
    expect(deriveComputerUseStatus({ items: [running], runId, isWorking: false })).toBeNull();
    expect(
      deriveComputerUseStatus({
        items: [running],
        runId: RunId.make("new-run"),
        isWorking: true,
      }),
    ).toBeNull();
  });

  it("uses native operation names without trusting same-name tools from another server", () => {
    const native = (toolName: string) =>
      tool({ toolName, toolSurface: undefined, toolSource: undefined });
    expect(derive([native("mcp__weasel_desktop__desktop_observe")])?.phase).toBe(
      "Requesting screen capture",
    );
    expect(derive([native("weasel_desktop.desktop_semantic_direct")])?.phase).toBe(
      "Reading accessibility",
    );
    expect(derive([native("mcp__other__desktop_observe")])).toBeNull();
    const policy = {
      ...native("desktop_status"),
      status: "completed" as const,
      title: "private title",
      output: {
        schema: 1,
        observation_mode: "disabled",
        observation_active: false,
        observation_generation: 1,
      },
    };
    expect(derive([policy])).toMatchObject({
      phase: "Observation disabled at this call",
      action: null,
      live: false,
    });
    expect(derive([{ ...policy, outputOmitted: true }])?.phase).toBe(
      "Observation policy unconfirmed",
    );
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      expect(derive([{ ...policy, status }])?.phase).toBe(
        `${status === "failed" ? "Tool failed" : "Tool stopped"} · observation policy unconfirmed`,
      );
    }
  });
});
