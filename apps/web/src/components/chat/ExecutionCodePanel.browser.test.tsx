import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

const harness = vi.hoisted(() => ({
  query: vi.fn(),
  highlight: vi.fn(({ code }: { code: string }) => code),
}));
vi.mock("../../state/queries", () => ({ useTurnItemDetail: harness.query }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("./HighlightedTokens", () => ({ HighlightedTokens: harness.highlight }));
import { ExecutionCodePanel } from "./ExecutionCodePanel";

const environmentId = EnvironmentId.make("node");
const base = {
  id: TurnItemId.make("execution-original"),
  threadId: ThreadId.make("thread-original"),
  runId: RunId.make("run-original"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running" as const,
  title: null,
  startedAt: DateTime.makeUnsafe("2026-10-15T00:00:00Z"),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-15T00:00:01Z"),
};
const input = "  python3 - <<'PY'\nprint('original 🦦')\nPY\n" + "# long\n".repeat(400);
const item: OrchestrationV2TurnItem = {
  ...base,
  type: "command_execution",
  input,
  outputOmitted: true,
};
function panel(overrides: Partial<ComponentProps<typeof ExecutionCodePanel>> = {}) {
  return (
    <ExecutionCodePanel
      threadRef={scopeThreadRef(environmentId, base.threadId)}
      target={{ environmentId, threadId: base.threadId, itemId: base.id, runId: base.runId }}
      wireItem={item}
      {...overrides}
    />
  );
}
function setup() {
  harness.query.mockReset();
  harness.highlight.mockClear();
}
const inputText = (host: HTMLElement) =>
  host.querySelector('[aria-label="Recorded input"]')?.textContent;
describe("execution code panel", () => {
  it("does not query another environment while panel presence still holds the old surface", async () => {
    setup();
    harness.query.mockReturnValue({ data: { item }, isPending: false, error: null });
    await using screen = await render(
      panel({ threadRef: scopeThreadRef(EnvironmentId.make("other-host"), base.threadId) }),
    );
    expect(harness.query).toHaveBeenLastCalledWith(null);
    expect(inputText(screen.container)).toBeUndefined();
  });
  it("shows an explicitly recorded script field on real lines, retaining the full arguments separately", async () => {
    setup();
    const code = "function greet() {\n  return '🦦';\n}\ngreet();\n";
    const dynamic: OrchestrationV2TurnItem = {
      ...base,
      type: "dynamic_tool",
      toolName: "js",
      input: { code, extra: "original argument" },
    };
    harness.query.mockReturnValue({ data: { item: dynamic }, isPending: false, error: null });
    await using screen = await render(panel({ wireItem: dynamic }));
    expect(inputText(screen.container)).toBe(code);
    expect(
      screen.container.querySelector('[aria-label="Complete structured input"]')?.textContent,
    ).toContain('"extra": "original argument"');
  });
  it("retains complete large code while omitting expensive syntax coloring", async () => {
    setup();
    const large = "# original 🦦\n".repeat(10_000);
    harness.query.mockReturnValue({ data: null, isPending: false, error: null });
    await using screen = await render(panel({ wireItem: { ...item, input: large } }));
    expect(inputText(screen.container)).toBe(large);
    expect(harness.highlight).not.toHaveBeenCalled();
  });
  it("fetches through the existing authorized item route and keeps command/output separate after completion", async () => {
    setup();
    harness.query.mockReturnValue({ data: null, isPending: true, error: null });
    await using screen = await render(panel());
    const host = screen.container;
    expect(inputText(host)).toBe(input);
    expect(harness.query).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId,
        threadId: base.threadId,
        itemId: base.id,
        revision: "live",
      }),
    );
    const completed = {
      ...item,
      status: "completed",
      completedAt: DateTime.makeUnsafe("2026-10-15T00:00:02Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-15T00:00:02Z"),
      output: "separate stdout/stderr",
      outputOmitted: false,
    };
    harness.query.mockReturnValue({ data: { item: completed }, isPending: false, error: null });
    await screen.rerender(panel({ wireItem: completed as OrchestrationV2TurnItem }));
    expect(inputText(host)).toBe(input);
    expect(host.querySelector('[aria-label="Recorded output"]')?.textContent).toBe(
      "separate stdout/stderr",
    );
    expect(host.textContent).toContain("completed");
    expect(host.textContent).toContain("Not supplied for this execution");
    expect(host.textContent).toContain("historical file contents");
  });
  it("copies the exact input including whitespace and finds Unicode without running anything", async () => {
    setup();
    harness.query.mockReturnValue({ data: null, isPending: false, error: null });
    await using screen = await render(panel());
    const host = screen.container;
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const search = host.querySelector("input")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "🦦");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Matches on lines 2");
    await act(() =>
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(window.getSelection()?.toString()).toBe("🦦");
    await act(() =>
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Recorded input"]'));
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Copy input")!
        .click(),
    );
    expect(writeText).toHaveBeenCalledExactlyOnceWith(input);
    expect(inputText(host)).toBe(input);
  });
  it("never retargets a late item read across thread/environment/run switches", async () => {
    setup();
    harness.query.mockReturnValue({ data: { item }, isPending: false, error: null });
    await using screen = await render(panel());
    const host = screen.container;
    await screen.rerender(
      panel({
        threadRef: scopeThreadRef(EnvironmentId.make("other-host"), ThreadId.make("other-thread")),
        target: {
          environmentId: EnvironmentId.make("other-host"),
          threadId: ThreadId.make("other-thread"),
          itemId: base.id,
          runId: RunId.make("other-run"),
        },
        wireItem: undefined,
      }),
    );
    expect(inputText(host)).toBeUndefined();
    expect(host.textContent).not.toContain(input);
    expect(host.textContent).toContain("other-host");
  });
  it("does not replace full projected command input with the detail route's truncated prefix", async () => {
    setup();
    harness.query.mockReturnValue({
      data: { item: { ...item, input: "prefix\n… output truncated for transport" } },
      isPending: false,
      error: null,
    });
    await using screen = await render(panel());
    expect(inputText(screen.container)).toBe(input);
  });
  it("reports unavailable input, missing records and authorized read failures without fabricating code", async () => {
    setup();
    harness.query.mockReturnValue({
      data: {
        item: {
          ...base,
          type: "dynamic_tool",
          toolName: "code",
          input: { summary: "prefix", truncated: true },
        },
      },
      isPending: false,
      error: null,
    });
    await using screen = await render(panel({ wireItem: undefined }));
    const host = screen.container;
    expect(inputText(host)).toBeUndefined();
    expect(host.textContent).toContain("Complete recorded input is unavailable");
    harness.query.mockReturnValue({ data: { item: null }, isPending: false, error: "not found" });
    await screen.rerender(panel({ wireItem: undefined }));
    expect(host.textContent).toContain("authorized item read failed");
  });
});
