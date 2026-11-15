import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { flushSync } from "react-dom";
import { AudioPreview } from "../files/AudioPreview";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  createRef,
  Profiler,
  StrictMode,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import "~/index.css";

import { environmentThreadDetails } from "../../state/threads";
import { environmentCatalog } from "../../connection/catalog";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { MessagesTimeline } from "./MessagesTimeline";
import { createWorkspaceFocusController, workspaceAreaProps } from "../../lib/workspaceFocus";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "../../test-fixtures";
import {
  type PendingApproval,
  deriveTimelineEntriesFromVisibleTurnItems,
} from "../../session-logic";
import type { Root } from "mdast";
import { ViewedImagesTimelineRow } from "./TimelineWorkEntryRow";
import { remarkThoughtPreview, THOUGHT_PREVIEW_MAX_LENGTH } from "./TimelineWorkEntryRow.logic";
import { TimelineRowCtx } from "./timelineRowContext";
import { LeaderNavigation } from "../keyboard/LeaderNavigation";
import { leaveNavigationMode } from "../keyboard/navigationMode";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { collectThreadFindRanges } from "./threadFindHighlights";
import type { VoiceConversationItem } from "@t3tools/client-runtime/live-voice";
import { toastManager } from "../ui/toast";
import type { CitedHistory } from "./citationProcedure";
import type { TimelineNavigation } from "./timelineViewport";
import { rememberTimelinePosition } from "./timelineScrollAnchoring";
import { useTimelineFollow } from "./useTimelineFollow";
import { ThreadLinkBackButton } from "./ThreadLinkBackButton";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

const QUERY_FALLBACK = Atom.make(AsyncResult.initial<never, never>());
const environmentQuery = vi.hoisted(() => ({
  error: "Pull request not found" as string | null,
  data: null as unknown,
  pending: false,
  sources: new WeakSet<object>(),
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>> | null) => {
    const sourced = atom !== null && environmentQuery.sources.has(atom);
    const result = useAtomValue(sourced ? atom : QUERY_FALLBACK);
    return {
      data: sourced ? AsyncResult.getOrElse(result, () => null) : environmentQuery.data,
      dataUpdatedAt: 0,
      error: environmentQuery.error,
      failure: null,
      isPending: sourced ? result.waiting : environmentQuery.pending,
      isSuccess: false,
      refresh: () => {},
    };
  }) as never,
}));

const stubbedAsset = vi.hoisted(() => ({ url: "" }));
vi.mock(import("~/assets/assetUrls"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAssetUrlState: ((...args: Parameters<typeof actual.useAssetUrlState>) =>
      stubbedAsset.url
        ? { _tag: "Success", url: stubbedAsset.url }
        : actual.useAssetUrlState(...args)) as typeof actual.useAssetUrlState,
    useAssetUrls: ((...args: Parameters<typeof actual.useAssetUrls>) =>
      stubbedAsset.url
        ? args[1].map(() => stubbedAsset.url)
        : actual.useAssetUrls(...args)) as typeof actual.useAssetUrls,
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

async function renderElement(element: ReactElement, options: { router?: false } = {}) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container, ...options });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function setup({
  scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }>,
} = {}): Disposable {
  environmentQuery.error = "Pull request not found";
  environmentQuery.data = { tasks: scheduledTasks };
  environmentQuery.pending = false;
  environmentQuery.sources = new WeakSet();
  leaveNavigationMode();
  return { [Symbol.dispose]: leaveNavigationMode };
}

it("keeps revised Voice speech and a normal t3-ui result in one chronological timeline", async () => {
  using _state = setup();
  const props = baseProps();
  const speech = (
    id: string,
    speaker: "user" | "assistant",
    second: number,
    text: string,
    final: boolean,
  ): VoiceConversationItem => ({
    id: `voice:call:1:speech:${id}`,
    callKey: "call:1",
    kind: "speech",
    createdAt: `2026-03-17T19:12:${second}.000Z`,
    entry: {
      id,
      speaker,
      text,
      final,
      occurredAt: `2026-03-17T19:12:${second}.000Z`,
      updatedAt: CREATED_AT,
    },
  });
  const voice = [
    speech("user", "user", 26, "Bitte vergleiche die Varianten.", true),
    speech("live", "assistant", 29, "Der Vergleich", false),
  ];
  const result = message(
    'Ergebnis\n\n```t3-ui\n{"type":"chart","id":"comparison","title":"Vergleich","kind":"bar"}\n{"type":"point","id":"comparison","label":"A","value":3}\n```',
    { role: "assistant" },
  );
  const draw = (voiceItems: ReadonlyArray<VoiceConversationItem>) => (
    <MessagesTimeline {...props} timelineEntries={[result]} voiceItems={voiceItems} />
  );
  await using screen = await renderElement(draw(voice));
  await expect.element(screen.getByRole("article", { name: "You · Voice" })).toBeVisible();
  await expect.element(screen.getByRole("article", { name: "Live · Voice" })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Vergleich", exact: true }))
    .toBeVisible();
  const original = screen.container.querySelector(
    '[data-timeline-row-id="voice:call:1:speech:live"]',
  );
  expect(
    [...screen.container.querySelectorAll("[data-timeline-row-kind]")].map((row) =>
      row.getAttribute("data-timeline-row-kind"),
    ),
  ).toEqual(["voice", "message", "voice"]);
  await screen.rerender(
    draw([voice[0]!, speech("live", "assistant", 29, "Der Vergleich ist fertig.", true)]),
  );
  await expect
    .element(screen.getByText("Der Vergleich ist fertig.", { exact: true }))
    .toBeVisible();
  expect(screen.container.querySelector('[data-timeline-row-id="voice:call:1:speech:live"]')).toBe(
    original,
  );
  expect(screen.container.querySelectorAll("[data-streamable-ui]")).toHaveLength(1);
});

it.each([false, true])(
  "shows the initiating agent identity and link (remote: %s)",
  async (remote) => {
    using _state = setup();
    const senderThreadId = ThreadId.make("thread:initial-message-sender");
    const senderEnvironmentId = remote
      ? EnvironmentId.make("environment-agent-origin")
      : ENVIRONMENT_ID;
    await using screen = await renderTimeline([
      message("Check the cloud interface", {
        createdBy: "agent",
        creationSource: "mcp",
        ...(remote
          ? { remoteSender: { environmentId: senderEnvironmentId, threadId: senderThreadId } }
          : { senderThreadId }),
      }),
    ]);
    const link = await vi.waitFor(() => {
      const element = screen.container.querySelector<HTMLAnchorElement>(
        'a[aria-label^="Absenderthread öffnen:"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    expect(decodeURIComponent(link.getAttribute("href")!)).toContain(
      `/${senderEnvironmentId}/${senderThreadId}`,
    );
    expect(link.querySelector("[data-agent-identity]")).not.toBeNull();
    expect(link.textContent?.trim()).toMatch(/\S+\s+\S+/u);
    expect(screen.container.textContent).not.toContain("nicht erfasst");
    await click(link);
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toContain(encodeURIComponent(senderThreadId)),
    );
    expect(screen.router!.state.location.state.threadLinkOrigin).toBe(true);
  },
);

it("keeps legacy MCP messages readable without a missing-sender notice or invented link", async () => {
  using _state = setup();
  await using screen = await renderTimeline([
    message("Check the cloud interface", { createdBy: "user", creationSource: "mcp" }),
  ]);
  await vi.waitFor(() => expect(screen.container.textContent).toContain("MCP"));
  expect(screen.container.textContent).not.toContain("nicht erfasst");
  expect(screen.container.querySelector('a[aria-label^="Absenderthread öffnen:"]')).toBeNull();
});

it("copies only the keyboard-focused message, not another response or the whole transcript", async () => {
  using _state = setup();
  await using screen = await renderTimeline([
    message("First response", { role: "assistant" }, "first-keyboard"),
    message("Second response", { role: "assistant" }, "second-keyboard"),
  ]);
  using copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const selected = await vi.waitFor(() => {
    const element = screen.container.querySelector<HTMLElement>(
      '[data-keyboard-object="Message"][aria-label="Assistant message: Second response"]',
    );
    if (!element) throw new Error("Second response is not rendered");
    return element;
  });
  await act(async () => {
    selected.focus();
    selected.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }),
    );
  });
  expect(copy).toHaveBeenCalledExactlyOnceWith("Second response");
});

it("quotes the selected excerpt from the focused response through the existing citation path", async () => {
  using _state = setup();
  const cite = vi.fn<NonNullable<TimelineProps["onCiteAssistantText"]>>(() => true);
  await using screen = await renderTimeline(
    [message("Second response", { role: "assistant" }, "quoted-keyboard")],
    {
      onCiteAssistantText: cite,
    },
  );
  const object = await vi.waitFor(() => {
    const element = screen.container.querySelector<HTMLElement>('[data-keyboard-object="Message"]');
    if (!element) throw new Error("Response is not rendered");
    return element;
  });
  const source = object.querySelector<HTMLElement>("[data-assistant-citation-source]")!;
  const text = source.querySelector("p")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 7);
  range.setEnd(text, 15);
  await act(async () => {
    object.focus();
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    object.dispatchEvent(
      new KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true }),
    );
  });
  expect(cite).toHaveBeenCalledOnce();
  expect(cite.mock.calls[0]![0]).toMatchObject({
    messageId: "quoted-keyboard",
    text: "response",
    start: 7,
    end: 15,
  });
  expect(cite.mock.calls[0]![1].source).toBe(source);
});

it("enters the actual nested timeline message with Space m, selects text and refines its quote", async () => {
  using _state = setup();
  const cite = vi.fn<NonNullable<TimelineProps["onCiteAssistantText"]>>(() => true);
  await using screen = await renderElement(
    <>
      <LeaderNavigation groups={[]} isClaimed={() => false} showSidebar={() => {}} />
      <MessagesTimeline
        {...baseProps()}
        timelineEntries={[message("Second response", { role: "assistant" }, "keyboard-selection")]}
        onCiteAssistantText={cite}
      />
    </>,
  );
  const object = await vi.waitFor(() => {
    const element = screen.container.querySelector<HTMLElement>('[data-keyboard-object="Message"]');
    if (!element) throw new Error("Response is not rendered");
    return element;
  });
  await userEvent.keyboard(" ");
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Keyboard navigation"]')).not.toBeNull(),
  );
  await userEvent.keyboard("m");
  await vi.waitFor(() => expect(document.activeElement).toBe(object));
  const outer = object.closest(
    '[data-message-id="keyboard-selection"][data-message-role="assistant"]',
  );
  expect(outer).not.toBe(object);
  expect(outer?.getAttribute("data-leader-message-focus")).toBe("true");
  await userEvent.keyboard("s");
  expect(document.getSelection()?.toString()).toBe("Second response");
  await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
  expect(document.getSelection()?.toString()).toBe("Second respons");
  await userEvent.keyboard("q");
  expect(cite).toHaveBeenCalledOnce();
  expect(cite.mock.calls[0]![0]).toMatchObject({
    messageId: "keyboard-selection",
    text: "Second respons",
  });
});
const TASK_ID = ScheduledTaskId.make("task-1");
const AUTOMATION_PROMPT = "Triage the inbox\n\nLabel every new issue and close duplicates.";

describe("MessagesTimeline work rows", () => {
  it("keeps a tall HTML preview in place when its last accordion opens at the bottom", async () => {
    const props = baseProps();
    const html = injectHtmlRenderBootstrap(`<div style="height:1400px">Earlier preview content</div>
      <details><summary>More rows</summary><div style="height:900px">More rows</div></details>
      <script>addEventListener('message', e => { if(e.data === 'toggle') document.querySelector('details').open = !document.querySelector('details').open; }); parent.postMessage('listening', '*');</script>`);
    const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    // The frame loads on its own clock, and a toggle posted before its script runs is lost.
    const listening = new Promise<void>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (event.data !== "listening") return;
        window.removeEventListener("message", onMessage);
        resolve();
      };
      window.addEventListener("message", onMessage);
    });
    function Preview() {
      const [height, setHeight] = useState(1437);
      return (
        <div style={{ height }}>
          <HtmlRenderDocument
            src={src}
            title="Tall preview"
            className="size-full"
            onContentHeight={setHeight}
          />
        </div>
      );
    }
    const container = document.createElement("div");
    container.style.cssText = "height:600px;width:900px;display:flex;flex-direction:column";
    await using screen = await render(
      <MessagesTimeline
        {...props}
        renderHtmlRender={() => <Preview />}
        timelineEntries={[
          {
            id: "preview",
            kind: "html-render",
            createdAt: CREATED_AT,
            runId: RunId.make("preview-run"),
            htmlRender: { attachmentId: "preview", title: "Tall preview", height: 1450 },
          },
          message("Done", { role: "assistant" }, "preview-done"),
        ]}
      />,
      { container },
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    const frame = screen.getByTitle("Tall preview").element() as HTMLIFrameElement;
    await vi.waitFor(() => {
      expect(frame.clientHeight).toBe(1437);
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
    });
    await listening;
    const top = frame.getBoundingClientRect().top;
    frame.focus();
    frame.contentWindow!.postMessage("toggle", "*");
    await vi.waitFor(() => {
      expect(frame.clientHeight).toBe(2337);
      expect(frame.getBoundingClientRect().top).toBeCloseTo(top, 0);
    });
    frame.contentWindow!.postMessage("toggle", "*");
    await vi.waitFor(() => {
      expect(frame.clientHeight).toBe(1437);
      expect(frame.getBoundingClientRect().top).toBeCloseTo(top, 0);
    });
  });

  it("keeps the worked-for heading in place when expanded at the bottom", async () => {
    const props = baseProps();
    const runId = RunId.make("completed-run");
    const container = document.createElement("div");
    // Keep the heading on screen so Playwright does not scroll it before clicking.
    container.style.cssText =
      "height: min(600px, 100vh); width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          ...Array.from({ length: 12 }, (_, index) =>
            message(`Earlier context ${index}`, {}, `context-${index}`),
          ),
          message("Progress details\n\n".repeat(50), { role: "assistant", runId }, "progress"),
          message("Done", { role: "assistant", runId }, "final"),
        ]}
      />,
      { container },
    );
    const heading = screen.getByRole("button", { name: /^Worked for/ });
    // LegendList keeps rows click-through until its initial scroll settles on animation
    // frames, which the fake clock below would freeze.
    await expect.element(heading).toHaveStyle({ pointerEvents: "auto" });
    const viewport = props.listRef.current!.getScrollableNode()!;
    // Legend keeps rows transparent and unclickable until its initial scroll settles.
    await vi.waitFor(() => {
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
      expect(heading.element().checkVisibility({ opacityProperty: true })).toBe(true);
    });
    expect(viewport.scrollTop).toBeGreaterThan(0);
    const top = heading.element().getBoundingClientRect().top;
    const height = viewport.scrollHeight;
    using _timers = fakeTimers();
    await heading.click();
    await act(() => vi.advanceTimersByTime(1000));
    await vi.waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(height + 500);
      expect(heading.element().getBoundingClientRect().top).toBeCloseTo(top, 0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        500,
      );
    });
  });

  it("keeps following a streaming turn after a heading is expanded at the bottom", async () => {
    const props = { ...baseProps(), isWorking: true };
    const runId = RunId.make("live-run");
    const container = document.createElement("div");
    container.style.cssText =
      "height: min(600px, 100vh); width: 900px; display: flex; flex-direction: column;";
    const entries = [
      ...Array.from({ length: 12 }, (_, index) =>
        message(`Earlier context ${index}`, {}, `context-${index}`),
      ),
      message("Progress details\n\n".repeat(50), { role: "assistant", runId }, "progress"),
      message("Done", { role: "assistant", runId }, "final"),
    ];
    await using screen = await render(<MessagesTimeline {...props} timelineEntries={entries} />, {
      container,
    });
    const heading = screen.getByRole("button", { name: /^Worked for/ });
    await expect.element(heading).toHaveStyle({ pointerEvents: "auto" });
    const viewport = props.listRef.current!.getScrollableNode()!;
    const distanceFromEnd = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThan(2));
    await heading.click();
    await screen.rerender(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          ...entries,
          message("Streamed reply\n\n".repeat(40), { role: "assistant", runId }, "streamed"),
        ]}
      />,
    );
    await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThan(2));
  });

  it.each(["delegated", "legacy", "missing"] as const)(
    "uses the reported task for %s completion notifications",
    async (source) => {
      setup();
      const now = DateTime.makeUnsafe(CREATED_AT);
      const childThreadId = ThreadId.make("shared-child");
      const task = (
        id: string,
        status: OrchestrationV2Subagent["status"],
        result: string,
      ): OrchestrationV2Subagent => ({
        id: NodeId.make(id),
        threadId: ThreadId.make("thread-1"),
        runId: null,
        parentNodeId: NodeId.make("parent-root"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Simplify delivery",
        title: "Simplify delivery",
        model: null,
        status,
        result,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
      const tasks = [
        task("original", "interrupted", "Old interrupted progress"),
        task("continued", "completed", "Final implementation report"),
        task("follow-up", "completed", "Follow-up explanation"),
      ];
      using _threadAtom = vi.spyOn(environmentThreadDetails, "threadAtom").mockReturnValue(
        Atom.make({
          projection: { subagents: tasks, turnItems: [], visibleTurnItems: [] },
        }) as never,
      );
      const onOpenThread = vi.fn();
      await using screen = await renderTimeline(
        (source === "delegated" ? ["continued", "follow-up"] : [source]).map((id) =>
          work(`notification-${id}`, {
            label: "Notification fallback",
            tone: "info",
            itemType: "notification",
            projectedItem: v2Item("notification", {
              id: `notification-${id}`,
              source:
                source === "legacy"
                  ? { kind: "subagent", childThreadId }
                  : { kind: "delegated_task", childThreadId, taskIds: [NodeId.make(id)] },
              outcome: "completed",
              summary: "Notification fallback",
            }),
          }),
        ),
        { onOpenThread },
      );
      if (source === "delegated") {
        expect(screen.text()).toContain("Final implementation report");
        expect(screen.text()).toContain("Follow-up explanation");
        expect(screen.text()).not.toContain("Old interrupted progress");
        await click(screen.buttons("Open Simplify delivery")[0]!);
        expect(onOpenThread).toHaveBeenCalledWith(childThreadId);
      } else if (source === "legacy") {
        expect(screen.text()).toContain("Old interrupted progress");
      } else {
        expect(screen.text()).toContain("Notification fallback");
        expect(screen.text()).not.toContain("Old interrupted progress");
      }
    },
  );
});

describe("MessagesTimeline messages", () => {
  it("keeps an expanded long message and its reading position after switching threads", async () => {
    using _state = setup();
    const props = { ...baseProps(), liveFollowEnabled: false };
    const entry = message("A paragraph to read across thread switches.\n\n".repeat(100));
    const draw = (other = false) => (
      <MessagesTimeline
        {...props}
        routeThreadKey={other ? `${props.routeThreadKey}:other` : props.routeThreadKey}
        timelineEntries={other ? [message("Other thread", {}, "other")] : [entry]}
      />
    );
    await using screen = await renderElement(draw());
    await screen.getByRole("button", { name: "Show full message" }).click();
    const scroll = props.listRef.current!.getScrollableNode()!;
    await act(() => {
      scroll.scrollTop = 600;
      scroll.dispatchEvent(new Event("scroll"));
    });
    await vi.waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(500));
    await screen.rerender(draw(true));
    await screen.rerender(draw());
    await vi.waitFor(() => {
      expect(
        screen.container.querySelector<HTMLElement>("[data-user-message-body]")?.dataset
          .userMessageCollapsed,
      ).toBe("false");
      expect(props.listRef.current!.getScrollableNode()!.scrollTop).toBeGreaterThan(500);
    });
  });

  it("settles when equally long messages have very different rendered heights", async () => {
    const props = baseProps();
    const tall = message("a\n\n".repeat(6000), { role: "assistant" }, "tall");
    const earlier = Array.from({ length: 80 }, (_, index) =>
      message(
        `<details><summary>Reply ${index}</summary>${"compact ".repeat(2250)}</details>`,
        { role: "assistant" },
        `earlier-${index}`,
      ),
    );
    let nestedCommits = 0;
    let maxNestedCommits = 0;
    const onRender = (_id: string, phase: string) => {
      nestedCommits = phase === "nested-update" ? nestedCommits + 1 : 0;
      maxNestedCommits = Math.max(maxNestedCommits, nestedCommits);
    };
    const timeline = (entries: Entry[]) => (
      <Profiler id="timeline" onRender={onRender}>
        <MessagesTimeline {...props} timelineEntries={entries} />
      </Profiler>
    );
    await using screen = await renderElement(timeline([tall]));
    await vi.waitFor(() =>
      expect(props.listRef.current?.getState().sizeAtIndex(0)).toBeGreaterThan(100_000),
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    await act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await screen.rerender(timeline([...earlier, tall]));
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 0, animated: false });
    });
    await vi.waitFor(async () => {
      await act(() => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(screen.text().includes("Reply 0")).toBe(true);
      expect(props.listRef.current!.getState().sizeAtIndex(0)).toBeGreaterThan(0);
    });
    expect(maxNestedCommits).toBeLessThan(20);
  });

  it("folds a user message only when the fold hides at least as much as it shows", async () => {
    setup();
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => `Line ${index}`).join("\n");
    const quotedText = "A long assistant paragraph that the user quoted. ".repeat(40);
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: ENVIRONMENT_ID,
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: quotedText,
      comment: "Why does this matter?",
      start: 0,
      end: quotedText.length,
      prefix: "",
      suffix: "",
    });
    await using screen = await renderTimeline([
      message(lines(12), {}, "medium"),
      message(lines(60), {}, "long"),
      message(`${citation} Can you expand on this?`, {}, "quoted"),
    ]);
    await vi.waitFor(() => expect(screen.buttons("Show full message")).toHaveLength(1));
    const [medium, long, quoted] = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-user-message-body]"),
    ];
    expect(quoted!.dataset.userMessageCollapsible).toBe("false");
    expect(quoted!.textContent).toContain("Can you expand on this?");
    expect(medium!.dataset.userMessageCollapsible).toBe("false");
    expect(medium!.textContent).toContain("Line 11");
    const foldedHeight = long!.offsetHeight;
    await click(screen.button("Show full message"));
    expect(long!.offsetHeight).toBeGreaterThanOrEqual(foldedHeight * 2);
  });

  it("keeps the first and last message headings reachable from either end", async () => {
    setup();
    const props = baseProps();
    // Folded messages at both ends: their headings must not live inside the fold.
    const entries = Array.from({ length: 120 }, (_, index) =>
      index === 0
        ? message("First turn", { scheduledTaskId: TASK_ID }, "turn-0")
        : index === 119
          ? message(
              "Last turn",
              { createdBy: "agent", senderThreadId: ThreadId.make("thread-sender") },
              "turn-119",
            )
          : message(
              `Turn ${index}:\n\n${"x ".repeat(200)}`,
              { role: index % 2 === 0 ? "user" : "assistant" },
              `turn-${index}`,
            ),
    );
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={entries} />,
    );
    const headings = () => [...screen.container.querySelectorAll("h3")];
    const headingFor = (text: string) =>
      headings().find((heading) => heading.parentElement?.textContent?.includes(text));
    const viewport = props.listRef.current!.getScrollableNode()!;
    // A screen reader scrolls the heading it moves to into view.
    const expectHeadingInView = async (text: string, neighbour: string) => {
      await act(() => headingFor(text)!.scrollIntoView({ block: "start" }));
      await vi.waitFor(() => expect(screen.text()).toContain(neighbour));
      const row = headingFor(text)!.parentElement!.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      expect(row.top).toBeLessThan(view.bottom);
      expect(row.bottom).toBeGreaterThan(view.top);
    };

    await vi.waitFor(() => expect(screen.text()).toContain("Turn 118:"));
    expect(screen.text()).not.toContain("Turn 60:");
    // Wrapping follows DOM order, so the ends must also sit first and last.
    await vi.waitFor(() => {
      expect(headings()[0]).toBe(headingFor("First turn"));
      expect(headings().at(-1)).toBe(headingFor("Last turn"));
    });

    await expectHeadingInView("First turn", "Turn 1:");
    expect(headingFor("Last turn")).toBeDefined();
    await expectHeadingInView("Last turn", "Turn 118:");
  });

  it("scrolls from the keyboard once F6 moves into the conversation", async () => {
    setup();
    const props = baseProps();
    const entries = Array.from({ length: 40 }, (_, index) =>
      message(`Turn ${index}:\n\n${"x ".repeat(200)}`, {}, `turn-${index}`),
    );
    await using _screen = await renderElement(
      <>
        <div
          {...workspaceAreaProps("conversation", 1, "Conversation")}
          className="relative flex min-h-0 flex-1 flex-col"
        >
          <MessagesTimeline {...props} timelineEntries={entries} />
        </div>
        <div {...workspaceAreaProps("composer", 2, "Message input")}>
          <button type="button">Send</button>
        </div>
      </>,
    );
    const focus = createWorkspaceFocusController(document);
    using _focus = { [Symbol.dispose]: focus.dispose };
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    const atEnd = viewport.scrollTop;
    page.getByRole("button", { name: "Send" }).element().focus();
    await userEvent.keyboard("{F6}");
    focus.move(-1);
    expect(viewport).toHaveAttribute("data-workspace-keyboard-focus");
    await userEvent.keyboard("{PageUp}");
    await vi.waitFor(() => expect(viewport.scrollTop).toBeLessThan(atEnd));
  });

  it("disables the minimap's next turn button at the bottom of the thread", async () => {
    setup();
    const props = baseProps();
    const entries = Array.from({ length: 16 }, (_, index) => [
      message(`Question ${index}`, {}, `user-${index}`),
      message(`Answer ${index}`, { role: "assistant" }, `assistant-${index}`),
    ]).flat();
    await using screen = await renderTimeline(entries, props);
    const viewport = props.listRef.current!.getScrollableNode()!;
    const strips = () => [
      ...screen.container.querySelectorAll<HTMLElement>("[data-minimap-strip]"),
    ];
    // Several final turns share the last screen, so the current turn is not the last one.
    await vi.waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
      expect(strips()[0]?.dataset.inView).toBe("false");
      expect(
        strips()
          .slice(-2)
          .map((strip) => strip.dataset.inView),
      ).toEqual(["true", "true"]);
      expect(screen.button("Previous turn")).not.toBeDisabled();
    });

    expect(screen.button("Next turn")).toBeDisabled();

    viewport.scrollTop -= 30;
    await vi.waitFor(() => expect(screen.button("Next turn")).not.toBeDisabled());
    // Legend keeps its initial end anchor until a scroll leaves the end, and re-pins on resize.
    viewport.scrollTop = 0;
    await vi.waitFor(() => expect(strips()[0]?.dataset.inView).toBe("true"));

    // Shrinking a detached viewport moves the bottom away without a scroll event.
    await screen.rerender(
      <MessagesTimeline {...props} timelineEntries={entries} liveFollowEnabled={false} />,
    );
    viewport.scrollTop = viewport.scrollHeight;
    await vi.waitFor(() => expect(screen.button("Next turn")).toBeDisabled());
    screen.container.style.height = "600px";
    await vi.waitFor(() => {
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        500,
      );
      expect(screen.button("Next turn")).not.toBeDisabled();
    });

    // So does a footer that grows below a detached bottom.
    viewport.scrollTop = viewport.scrollHeight;
    await vi.waitFor(() => expect(screen.button("Next turn")).toBeDisabled());
    await screen.rerender(
      <MessagesTimeline
        {...props}
        timelineEntries={entries}
        liveFollowEnabled={false}
        footer={<div style={{ height: 400 }} />}
      />,
    );
    await vi.waitFor(() => {
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        300,
      );
      expect(screen.button("Next turn")).not.toBeDisabled();
    });
  });

  it("enables the minimap's next turn button on a thread restored above its bottom", async () => {
    setup();
    const base = baseProps();
    const turns = (prefix: string) =>
      Array.from({ length: 16 }, (_, index) => [
        message(`${prefix} question ${index}`, {}, `${prefix}-user-${index}`),
        message(`${prefix} answer ${index}`, { role: "assistant" }, `${prefix}-assistant-${index}`),
      ]).flat();
    const other = "environment-local:thread-minimap-restored";
    rememberTimelinePosition(
      other,
      { rowId: "entry-b-user-4", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={turns("a")} />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(screen.button("Next turn")).toBeDisabled();
    });

    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={turns("b")}
        liveFollowEnabled={false}
      />,
    );
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-b-user-4"]');
      expect(row).not.toBeNull();
      expect(
        Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
      ).toBeLessThanOrEqual(2);
      expect(screen.button("Next turn")).not.toBeDisabled();
    });
  });

  it("keeps rows in item order after a reload or thread switch, before any timer runs", async () => {
    setup();
    // NVDA's browse mode keeps the first DOM order it reads, so a timer that sorts rows later is too late.
    using _timers = fakeTimers();
    const thread = (name: string) =>
      Array.from({ length: 120 }, (_, index) =>
        message(
          `${name} turn ${index}:\n\n${"x ".repeat(200)}`,
          { role: index % 2 === 0 ? "user" : "assistant" },
          `${name}-${index}`,
        ),
      );
    const props = baseProps();
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={thread("A")} />,
    );
    const turnsInDomOrder = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) =>
        Number(/turn (\d+):/.exec(heading.parentElement?.textContent ?? "")?.[1]),
      );
    const expectItemOrder = () => {
      const turns = turnsInDomOrder();
      expect(turns).toEqual(turns.toSorted((a, b) => a - b));
    };

    expect(screen.text()).toContain("A turn 118:");
    expect(turnsInDomOrder()).toContain(0);
    expectItemOrder();

    await screen.rerender(
      <MessagesTimeline
        {...props}
        routeThreadKey={`${props.routeThreadKey}-other`}
        timelineEntries={thread("B")}
      />,
    );
    expect(screen.text()).toContain("B turn 118:");
    expect(screen.text()).not.toContain("A turn");
    expectItemOrder();
  });

  it("puts rows back in item order soon after a continuous scroll stops", async () => {
    setup();
    const props = baseProps();
    await using screen = await renderElement(
      <MessagesTimeline
        {...props}
        timelineEntries={Array.from({ length: 120 }, (_, index) =>
          message(
            `Turn ${index}:\n\n${"x ".repeat(200)}`,
            { role: index % 2 === 0 ? "user" : "assistant" },
            `turn-${index}`,
          ),
        )}
      />,
    );
    await vi.waitFor(() => expect(screen.text()).toContain("Turn 118:"));
    using _timers = fakeTimers();
    const turnsInDomOrder = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) =>
        Number(/Turn (\d+):/.exec(heading.parentElement?.textContent ?? "")?.[1]),
      );
    const viewport = props.listRef.current!.getScrollableNode()!;

    const scroll = async (by: number) => {
      for (let step = 0; step < 40; step++) {
        await act(() => {
          viewport.scrollTop += by;
          viewport.dispatchEvent(new Event("scroll"));
          vi.advanceTimersByTime(16);
        });
      }
      // Wrapping right after a scroll must still reach the first and last message.
      expect(turnsInDomOrder()[0]).toBe(0);
      expect(turnsInDomOrder().at(-1)).toBe(119);
    };

    await act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(300);
    });
    await scroll(300);
    expect(turnsInDomOrder().filter((turn) => turn > 0 && turn < 100).length).toBeGreaterThan(0);
    await scroll(-300);

    await act(() => vi.advanceTimersByTime(300));
    const turns = turnsInDomOrder();
    expect(turns).toEqual(turns.toSorted((a, b) => a - b));
  });

  it("steps the minimap's next turn past two adjacent user messages", async () => {
    const props = baseProps();
    const reply = (id: string) => message("Reply.\n\n".repeat(120), { role: "assistant" }, id);
    const userIds = ["turn-0", "turn-1", "turn-2", "pair-a", "pair-b", "turn-3", "turn-4"];
    const entries = [
      ...["turn-0", "turn-1", "turn-2"].flatMap((id) => [message(id, {}, id), reply(`${id}-r`)]),
      message("pair-a", {}, "pair-a"),
      message("pair-b", {}, "pair-b"),
      reply("pair-b-r"),
      ...["turn-3", "turn-4"].flatMap((id) => [message(id, {}, id), reply(`${id}-r`)]),
    ];
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      await using screen = await renderTimeline(entries, props);
      const viewport = props.listRef.current!.getScrollableNode()!;
      const strips = () => [...screen.container.querySelectorAll("[data-minimap-strip]")];
      const turnAtTop = () =>
        userIds.find((id) => {
          const row = screen.container.querySelector(`[data-message-id="${id}"]`);
          if (!row) return false;
          const offset = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
          return offset >= 0 && offset < 100;
        });
      await act(() => {
        void props.listRef.current!.scrollToIndex({ index: 0, animated: false });
      });
      await vi.waitFor(() => expect(strips()[0]?.getAttribute("data-in-view")).toBe("true"));

      // Clicks again while the view has not moved, as a user would.
      for (const id of userIds.slice(1)) {
        const from = turnAtTop();
        await vi.waitFor(async () => {
          if (turnAtTop() === from) await click(screen.button("Next turn"));
          expect(turnAtTop(), "turn at the top after Next turn").toBe(id);
        });
      }
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("keeps single tildes in user paths literal without changing double tildes or assistant text", async () => {
    const source =
      "Install the skill as ~/folder-a/skills/x, then follow the guide (~/folder-a/guide.md).";
    await using screen = await renderTimeline([
      message(source),
      message("Drop ~~the old plan~~", {}, "message-2"),
      message(source, { role: "assistant" }, "assistant-1"),
    ]);
    const [user, doubleTilde, assistant] = screen.container.querySelectorAll<HTMLElement>(
      "[data-timeline-row-kind=message]",
    );
    expect(user?.textContent).toContain(source);
    expect(user?.querySelector("del")).toBeNull();
    expect(doubleTilde?.querySelector("del")?.textContent).toBe("the old plan");
    expect(assistant?.querySelector("del")?.textContent).toBe(
      "/folder-a/skills/x, then follow the guide (",
    );
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  const revealModes = ["inline", "at-end", "delayed", "grouped-delayed", "grouped-end"];
  it.each(revealModes)("reveals %s output", async (mode) => {
    const inline = mode === "inline" || mode === "at-end";
    setup();
    environmentQuery.data =
      mode === "grouped-end"
        ? {
            output: { text: `${"output line\n".repeat(10)}TOOL_INPUT_END`, truncated: false },
            running: false,
          }
        : null;
    environmentQuery.error = null;
    const props = baseProps();
    const composerOverlayHeight = mode === "grouped-end" ? 140 : 200;
    const tallEntries = Array.from({ length: 12 }, (_, index) =>
      message(
        `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
        { role: "assistant" },
        `tall-${index}`,
      ),
    );
    const projectedItem = makeStreamingTimelineFixture().visibleTurnItems[1]!;
    const source = {
      detail: () => Atom.make(AsyncResult.initial()),
      commandOutput: () => Atom.make(AsyncResult.initial()),
    };
    let outerGrowth = false;
    let routeThreadKey = props.routeThreadKey;
    const timeline = () => (
      <MessagesTimeline
        {...props}
        routeThreadKey={routeThreadKey}
        liveFollowEnabled={false}
        {...(inline
          ? {}
          : {
              turnItemSource: {
                detail: () => source.detail(),
                commandOutput: () => source.commandOutput(),
              },
            })}
        contentInsetEndAdjustment={composerOverlayHeight}
        timelineEntries={[
          ...tallEntries.slice(0, 6),
          {
            id: "tool-near-composer",
            kind: "work",
            createdAt: CREATED_AT,
            entry: {
              id: "tool-near-composer",
              createdAt: CREATED_AT,
              label: "Example tool",
              toolTitle: "Example tool",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "completed",
              toolData: { input: { query: `${"x".repeat(1200)} TOOL_INPUT_END` } },
              ...(inline
                ? {}
                : {
                    itemType: "command_execution",
                    projectedItem,
                    structuredPayload: projectedItem.item,
                  }),
            },
          },
          ...(mode.startsWith("grouped-")
            ? [
                {
                  id: "another-tool",
                  kind: "work" as const,
                  createdAt: CREATED_AT,
                  entry: {
                    id: "another-tool",
                    createdAt: CREATED_AT,
                    label: "Other tool",
                    tone: "tool" as const,
                    itemType: "dynamic_tool" as const,
                    toolLifecycleStatus: "completed" as const,
                    toolData: { input: { query: "other" } },
                  },
                },
              ]
            : []),
          ...(mode === "grouped-end"
            ? [message("Completed.", { role: "assistant" }, "final-message")]
            : mode === "at-end"
              ? [message("Done.", { role: "assistant" }, "final-message")]
              : tallEntries.slice(6)),
          ...(outerGrowth
            ? [message("Later output\n\n".repeat(20), { role: "assistant" }, "outer-growth")]
            : []),
        ]}
      />
    );
    await using screen = await renderElement(
      mode === "grouped-delayed" ? (
        <MessagesTimeline {...props} timelineEntries={[message("Previous thread")]} />
      ) : (
        timeline()
      ),
    );
    if (mode === "grouped-end") screen.container.style.height = "648px";
    await vi.waitFor(() => expect(props.listRef.current?.getScrollableNode()).toBeTruthy());
    const viewport = props.listRef.current!.getScrollableNode()!;
    if (mode === "grouped-delayed") {
      routeThreadKey = `${routeThreadKey}-switched`;
      await screen.rerender(timeline());
      await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(3000));
      await act(() => viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })));
    }
    if (mode.startsWith("grouped-")) {
      await act(() => {
        void props.listRef.current!.scrollToIndex({ index: 6, animated: false });
      });
      await vi.waitFor(() =>
        expect(
          screen.container.querySelector('[data-timeline-row-kind="work-toggle"] button'),
        ).not.toBeNull(),
      );
      const group = () =>
        screen.container.querySelector<HTMLElement>(
          '[data-timeline-row-kind="work-toggle"] button',
        )!;
      await click(group());
      await vi.waitFor(() =>
        expect(
          screen.container.querySelector('[data-work-entry-id="tool-near-composer"]'),
        ).not.toBeNull(),
      );
      if (mode === "grouped-delayed") {
        await click(
          screen.container.querySelector<HTMLElement>('[data-work-entry-id="tool-near-composer"]')!,
        );
        await vi.waitFor(() => expect(screen.text()).toContain("Loading output"));
        await click(group());
      }
    }
    const header = () => {
      if (mode === "grouped-end")
        return screen.container.querySelector<HTMLElement>(
          '[data-work-entry-id="tool-near-composer"]',
        )!;
      if (mode === "grouped-delayed")
        return screen.container.querySelector<HTMLElement>(
          '[data-timeline-row-kind="work-toggle"] button',
        )!;
      const rows = screen.container.querySelectorAll<HTMLElement>(
        '[data-timeline-row-kind="work"] [role="button"]',
      );
      if (!rows[0]) throw new Error(screen.text());
      return rows[0];
    };
    const visibleBottom = () => viewport.getBoundingClientRect().bottom - composerOverlayHeight;
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 6, animated: false });
    });
    if (mode === "at-end") {
      await act(() => {
        void props.listRef.current!.scrollToEnd({ animated: false });
      });
      await vi.waitFor(() =>
        expect(resolveTimelineIsAtEnd(props.listRef.current!.getState())).toBe(true),
      );
    } else {
      await vi.waitFor(async () => {
        await act(() => {
          viewport.scrollTop += header().getBoundingClientRect().bottom - (visibleBottom() - 8);
          viewport.dispatchEvent(new Event("scroll"));
        });
        expect(resolveTimelineIsAtEnd(props.listRef.current!.getState())).toBe(false);
        expect(header().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom());
        expect(header().getBoundingClientRect().top).toBeGreaterThan(
          viewport.getBoundingClientRect().top,
        );
      });
    }

    const collapsedScrollTop = viewport.scrollTop;
    using scrollBy = vi.spyOn(viewport, "scrollBy");
    // The nested row can measure before the outer scroller gains its new range.
    if (mode === "grouped-delayed") scrollBy.mockImplementationOnce(() => {});
    await click(header());
    if (mode === "grouped-delayed") {
      await vi.waitFor(() => expect(scrollBy).toHaveBeenCalled());
      outerGrowth = true;
      await screen.rerender(timeline());
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(collapsedScrollTop));
    }
    if (!inline && mode !== "grouped-end") {
      await vi.waitFor(() =>
        expect(header().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom() + 1),
      );
      await vi.waitFor(() => expect(screen.text()).toContain("Loading output"));
      environmentQuery.data = {
        output: { text: `${"output line\n".repeat(20)}TOOL_INPUT_END`, truncated: false },
        running: false,
      };
      await screen.rerender(timeline());
    }
    const inputEnd = () =>
      Array.from(screen.container.querySelectorAll<HTMLElement>("*")).findLast((element) =>
        element.textContent?.includes("TOOL_INPUT_END"),
      )!;
    await vi.waitFor(() =>
      expect(inputEnd().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom() + 1),
    );
    await vi.waitFor(() =>
      expect(header().getBoundingClientRect().top).toBeGreaterThanOrEqual(
        viewport.getBoundingClientRect().top,
      ),
    );
  });
});

function usageLimitEntries(resetAt: string) {
  const threadId = ThreadId.make("usage-limit-thread");
  const at = DateTime.makeUnsafe(CREATED_AT);
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("usage-limit"),
        item: {
          id: TurnItemId.make("usage-limit"),
          threadId,
          runId: RunId.make("usage-limit-run"),
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "error",
          status: "failed",
          failure: {
            class: "usage_limit",
            message: "You've hit your usage limit.",
            code: null,
            retryable: true,
            resetAt,
          },
        },
      },
    ],
    optimisticMessages: [],
  });
}

describe("MessagesTimeline usage limit notice", () => {
  it("labels the retry time with the viewer's timezone", async () => {
    await using screen = await renderTimeline(usageLimitEntries("2026-03-17T19:30:00.000Z"));
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.text()).toMatch(/Usage limit reached\. Retry after .+\./);
    expect(screen.text()).toContain(`(${timeZone})`);
  });

  it("keeps the retry time in the named zone after the viewer's timezone changes", async () => {
    const resetAt = "2026-07-01T19:30:00.000Z";
    const session = cdp();
    await session.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Madrid" });
    try {
      {
        await using _madrid = await renderTimeline(usageLimitEntries(resetAt));
      }
      await session.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
      await using screen = await renderTimeline(usageLimitEntries(resetAt));
      const newYorkTime = new Date(resetAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      });
      expect(screen.text()).toContain(`${newYorkTime} (America/New_York)`);
    } finally {
      await session.send("Emulation.setTimezoneOverride", { timezoneId: "" });
    }
  });
});

const CITATION_REQUEST = {
  key: "activation-1",
  citation: {
    version: 1,
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make("thread-cited"),
    messageId: MessageId.make("cited"),
    text: "the cited answer",
    start: 0,
    end: 16,
    prefix: "",
    suffix: "",
  },
} satisfies NonNullable<TimelineProps["citationRequest"]>;

describe("MessagesTimeline citations", () => {
  it.each([
    ["reply", false],
    ["reply", true],
    ["citation", false],
  ] as const)(
    "gives an explicit %s target priority over passive restore and keeps the return position (compact: %s)",
    async (kind, compact) => {
      setup();
      const base = baseProps();
      const sourceThreadId = ThreadId.make(base.routeThreadKey.slice(ENVIRONMENT_ID.length + 1));
      const targetEnvironmentId = compact
        ? EnvironmentId.make("environment-reply-target")
        : ENVIRONMENT_ID;
      const targetThreadId = compact ? sourceThreadId : ThreadId.make(`target-${kind}-restore`);
      const targetKey = `${targetEnvironmentId}:${targetThreadId}`;
      const targetId = MessageId.make("original-message");
      const replyTo = {
        environmentId: targetEnvironmentId,
        threadId: targetThreadId,
        messageId: targetId,
      };
      const projected = makeStreamingTimelineFixture().visibleTurnItems.find(
        (row) => row.item.type === (kind === "reply" ? "user_message" : "assistant_message"),
      );
      if (
        !projected ||
        (projected.item.type !== "user_message" && projected.item.type !== "assistant_message")
      ) {
        throw new Error("Expected an original conversation message");
      }
      const original = {
        ...projected,
        sourceThreadId: targetThreadId,
        item: {
          ...projected.item,
          threadId: targetThreadId,
          messageId: targetId,
          text: kind === "reply" ? "" : "the cited answer",
        },
      };
      const projection = makeThreadProjectionFixture();
      const thread = {
        environmentId: targetEnvironmentId,
        projection: {
          ...projection,
          thread: {
            ...projection.thread,
            id: targetThreadId,
            lineage: { ...projection.thread.lineage, rootThreadId: targetThreadId },
          },
          turnItems: [original.item],
          visibleTurnItems: [original],
        },
      } satisfies NonNullable<
        Atom.Type<ReturnType<typeof environmentThreadDetails.quietThreadAtom>>
      >;
      using _thread = vi
        .spyOn(environmentThreadDetails, "quietThreadAtom")
        .mockReturnValue(Atom.make(thread));
      using _history = vi.spyOn(environmentThreadDetails, "historyAtom").mockReturnValue(
        Atom.make({
          historyCursor: null,
          hasMoreHistory: false,
          loading: false,
          error: null,
          expanded: false,
          latestLocalTurnOrdinal: null,
        }),
      );
      using _status = vi
        .spyOn(environmentThreadDetails, "statusAtom")
        .mockReturnValue(Atom.make("live"));
      using _error = vi
        .spyOn(environmentThreadDetails, "errorAtom")
        .mockReturnValue(Atom.make(null));
      using _connection = vi
        .spyOn(environmentCatalog, "stateAtom")
        .mockReturnValue(Atom.make(AsyncResult.initial<never, never>()));
      const sourceEntries = Array.from({ length: 40 }, (_, index) =>
        message(
          `${kind === "reply" && index === 20 ? "Kurz: " : ""}Source ${index}\n\n${"line\n\n".repeat(8)}${kind === "reply" && index === 20 ? "\n\nTechnik:\n- Technischer Kontext für den Reply-Rückweg" : ""}`,
          kind === "reply" && index === 20
            ? { createdBy: "agent", creationSource: "mcp", senderThreadId: targetThreadId, replyTo }
            : {},
          `source-${index}`,
        ),
      );
      const targetEntries = Array.from({ length: compact ? 7 : 40 }, (_, index) =>
        index === (compact ? 0 : 5)
          ? {
              ...message(
                kind === "reply" ? "" : "the cited answer",
                { role: kind === "reply" ? "user" : "assistant" },
                targetId,
              ),
              projectedItem: original,
            }
          : message(
              `Target ${index}\n\n${"line\n\n".repeat(compact ? 2 : 8)}`,
              compact && index === 1
                ? {
                    createdBy: "agent",
                    creationSource: "mcp",
                    senderThreadId: targetThreadId,
                    replyTo,
                  }
                : {},
              `target-${index}`,
            ),
      );
      rememberTimelinePosition(
        base.routeThreadKey,
        { rowId: "entry-source-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
        false,
      );
      rememberTimelinePosition(
        targetKey,
        { rowId: "entry-target-30", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
        false,
      );
      const container = document.createElement("div");
      container.style.cssText = `height: ${compact ? 734 : 1200}px; width: 900px; display: flex; flex-direction: column;`;
      function FollowedTimeline({ timelineProps }: { timelineProps: TimelineProps }) {
        const follow = useTimelineFollow({
          legendListRef: base.listRef,
          composerTimelineInset: timelineProps.contentInsetEndAdjustment,
          routeThreadKey: timelineProps.routeThreadKey,
          activeThreadKey: timelineProps.routeThreadKey,
          isServerThread: true,
          serverProjection: null,
          threadStatus: "live",
          activeActivityRun: null,
          activeRunningTurnId: null,
          timelineEntries: timelineProps.timelineEntries,
          timelineAnchorMessageId: null,
          setTimelineAnchor: () => {},
        });
        return (
          <>
            <div style={{ position: "absolute", zIndex: 1 }}>
              <ThreadLinkBackButton />
            </div>
            <MessagesTimeline
              {...timelineProps}
              liveFollowEnabled={follow.timelineLiveFollowEnabled}
              onViewportAttach={follow.attachTimelineViewport}
              onIsAtEndChange={follow.onIsAtEndChangeStable}
              onFooterGrow={follow.onTimelineFooterGrowStable}
            />
          </>
        );
      }
      const source = () => (
        <FollowedTimeline
          timelineProps={{
            ...base,
            timelineEntries: sourceEntries,
            footer: <div style={{ height: 320 }} />,
          }}
        />
      );
      const target = (entries = targetEntries) => (
        <FollowedTimeline
          timelineProps={{
            ...base,
            routeThreadKey: targetKey,
            activeThreadEnvironmentId: targetEnvironmentId,
            timelineEntries: entries,
            footer: <div style={{ height: 240 }} />,
            contentInsetEndAdjustment: compact ? 240 : 0,
            ...(kind === "citation"
              ? {
                  citationRequest: {
                    ...CITATION_REQUEST,
                    citation: {
                      ...CITATION_REQUEST.citation,
                      threadId: targetThreadId,
                      messageId: targetId,
                    },
                  },
                  citationHistory: { _tag: "found" as const },
                }
              : {}),
          }}
        />
      );
      await using screen = await render(source(), {
        container,
        router: `/${ENVIRONMENT_ID}/${sourceThreadId}`,
      });
      const viewport = base.listRef.current!.getScrollableNode()!;
      const expectRowAtTop = (id: string) => {
        const row = container.querySelector(`[data-timeline-row-id="${id}"]`);
        expect(row).not.toBeNull();
        expect(
          Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
        ).toBeLessThanOrEqual(2);
      };
      await vi.waitFor(() => expectRowAtTop("entry-source-20"));
      using scrollToIndex = vi.spyOn(base.listRef.current!, "scrollToIndex");
      if (kind === "reply") {
        await screen
          .getByRole("button", { name: /^Details öffnen: Agentennachricht: Source 20/ })
          .click();
        await screen.getByText("Technik", { exact: true }).click();
        await screen.getByRole("button", { name: "Original", exact: true }).click();
        await screen.getByRole("link", { name: `Nachricht ${targetId}`, exact: true }).click();
        expect(screen.router!.state.location.state.threadLinkOrigin).toBe(true);
      } else {
        await act(() =>
          screen.router!.navigate({
            to: `/${targetEnvironmentId}/${targetThreadId}`,
          }),
        );
      }
      if (compact) {
        await screen.rerender(target(targetEntries.slice(-5)));
        await vi.waitFor(() => expect(base.listRef.current!.getState().data).toHaveLength(5));
      }
      await screen.rerender(target());
      const expectOriginalInView = () => {
        const row = container.querySelector(`[data-timeline-row-id="entry-${targetId}"]`);
        expect(row).not.toBeNull();
        expect(row!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          viewport.getBoundingClientRect().top,
        );
        expect(row!.getBoundingClientRect().top).toBeLessThan(
          viewport.getBoundingClientRect().bottom,
        );
      };
      await vi.waitFor(expectOriginalInView);
      if (compact) {
        expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        expect(viewport.scrollHeight - viewport.clientHeight).toBeLessThan(viewport.clientHeight);
      }
      const rows = base.listRef.current!.getState().data as ReadonlyArray<{ id: string }>;
      expect(
        scrollToIndex.mock.calls.some(([options]) => rows[options.index]?.id === "entry-target-30"),
      ).toBe(false);
      await screen.rerender(target([message("Older history", {}, "older"), ...targetEntries]));
      await vi.waitFor(expectOriginalInView);
      if (compact) {
        const updated = targetEntries.map((entry, index) =>
          index === 1
            ? message(`Target ${index}\n\n${"line\n\n".repeat(5)}`, {}, `target-${index}`)
            : entry,
        );
        await screen.rerender(target([message("Older history", {}, "older"), ...updated]));
        await vi.waitFor(expectOriginalInView);
        await screen.rerender(target([message("Older history", {}, "older"), ...targetEntries]));
        await vi.waitFor(expectOriginalInView);
      }
      if (kind === "reply") {
        if (compact) {
          const historyLength = screen.router!.history.length;
          await screen
            .getByRole("button", { name: /^Details öffnen: Agentennachricht: Target 1/ })
            .click();
          await screen.getByRole("link", { name: `Nachricht ${targetId}`, exact: true }).click();
          expect(screen.router!.state.location.state.threadLinkOrigin).toBe(true);
          expect(screen.router!.history.length).toBe(historyLength);
        }
        await screen.getByRole("button", { name: "Back to previous thread" }).click();
      } else {
        await act(() => {
          screen.router!.history.back();
        });
      }
      await screen.rerender(source());
      await vi.waitFor(() => expectRowAtTop("entry-source-20"));
      if (kind === "reply") {
        expect(
          container.querySelector(
            '[data-agent-message="source-20"] button[aria-label^="Zuklappen:"]',
          ),
        ).not.toBeNull();
        await expect
          .element(screen.getByRole("button", { name: "Original", exact: true }))
          .toHaveAttribute("aria-expanded", "true");
        expect(
          container.querySelector<HTMLDetailsElement>('[data-agent-message="source-20"] details')
            ?.open,
        ).toBe(true);
      }
    },
  );
  it("offers Cite for text an agent sent with send_to_user", async () => {
    const text = "The draft the next question refers to";
    await using screen = await renderTimeline(
      [
        {
          id: "sent",
          kind: "sent-message",
          createdAt: CREATED_AT,
          runId: RunId.make("run-sent"),
          text,
        },
      ],
      { onCiteAssistantText: () => true },
    );
    await expect.element(screen.getByText(text)).toHaveStyle({ pointerEvents: "auto" });
    await userEvent.tripleClick(screen.getByText(text));
    await expect
      .element(page.getByRole("button", { name: "Cite selection in composer" }))
      .toBeVisible();
  });

  it("lands a citation present at mount under StrictMode", async () => {
    await using _screen = await renderElement(
      <StrictMode>
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("A question", {}, "question"),
            message("the cited answer", { role: "assistant" }, "cited"),
          ]}
          citationRequest={CITATION_REQUEST}
          citationHistory={{ _tag: "found" }}
        />
      </StrictMode>,
      // The test router mounts route content without StrictMode's effect replay.
      { router: false },
    );
    // StrictMode replays effect cleanups on mount; the activation must survive them.
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("opens the superseded attempt that folds the cited response", async () => {
    const runId = RunId.make("run-steered");
    const attempt = (id: string, ordinal: number, status: "superseded" | "running") => ({
      id: RunAttemptId.make(id),
      runId,
      attemptOrdinal: ordinal,
      rootNodeId: `node-${id}` as never,
      status,
      completedAt: null,
    });
    const superseded = attempt("attempt-1", 1, "superseded");
    const active = attempt("attempt-2", 2, "running");
    const inAttempt = (entry: Entry, entryAttempt: typeof superseded): Entry => ({
      ...entry,
      attempt: entryAttempt,
    });
    await using _screen = await renderTimeline(
      [
        inAttempt(message("Build it", { runId }, "question"), superseded),
        inAttempt(message("the cited answer", { role: "assistant", runId }, "cited"), superseded),
        inAttempt(message("Change direction", { runId }, "steer"), active),
        inAttempt(message("Current response", { role: "assistant", runId }, "current"), active),
      ],
      {
        latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
        citationRequest: CITATION_REQUEST,
        citationHistory: { _tag: "found" },
      },
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("waits for cited history to load before giving up on a response outside the window", async () => {
    using toast = vi.spyOn(toastManager, "add");
    const props = baseProps();
    const citationRequest = CITATION_REQUEST;
    const recent = message("A recent question", {}, "recent");
    const timeline = (entries: Entry[], citationHistory: CitedHistory) => (
      <MessagesTimeline
        {...props}
        timelineEntries={entries}
        citationRequest={citationRequest}
        citationHistory={citationHistory}
      />
    );
    await using screen = await renderElement(timeline([recent], { _tag: "loading" }));
    await expect.element(screen.getByText("A recent question")).toBeVisible();

    await screen.rerender(
      timeline([message("the cited answer", { role: "assistant" }, "cited"), recent], {
        _tag: "found",
      }),
    );
    await expect.element(screen.getByText("the cited answer")).toBeVisible();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("MessagesTimeline automation prompts", () => {
  it("folds an automation prompt into a bubble titled by its task", async () => {
    setup({ scheduledTasks: [{ id: TASK_ID, title: "Nightly triage" }] });
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    const row = screen.button(/^Automation/);
    expect(row.textContent).toContain("Nightly triage");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("close duplicates");

    await click(row);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
    const link = [...screen.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Open automation",
    );
    expect(link?.getAttribute("href")).toContain(`taskId=${TASK_ID}`);
    expect(screen.buttons(/copy/i)).not.toHaveLength(0);
  });

  it("falls back to the prompt's first line without a task title", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    expect(screen.button(/^Automation/).textContent).toContain("Triage the inbox");
  });

  it("leaves ordinary user messages as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([message(AUTOMATION_PROMPT)]);
    expect(screen.buttons(/^Automation/)).toHaveLength(0);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
  });

  it("reveals a find match beyond the folded automation prompt's initial viewport", async () => {
    setup();
    const prompt = `${"Inspect the next item.\n\n".repeat(16)}Close duplicates.`;
    await using screen = await renderTimeline([message(prompt, { scheduledTaskId: TASK_ID })], {
      findExpanded: true,
      findQuery: "duplicates",
      activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
    });
    await vi.waitFor(() =>
      expect(screen.button(/^Automation/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "duplicates")[0]!;
    const details = screen.container.querySelector("[data-thread-find-text]")!;
    expect(range.getBoundingClientRect().top - details.getBoundingClientRect().top).toBeGreaterThan(
      384,
    );
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      details.getBoundingClientRect().bottom,
    );
  });

  it("shows edit-from-here once an automation prompt is expanded", async () => {
    setup();
    const runId = RunId.make("run-1");
    await using screen = await renderTimeline(
      [
        message(
          AUTOMATION_PROMPT,
          { scheduledTaskId: TASK_ID, runId, inputIntent: "turn_start" },
          "user-1",
        ),
        message("Done", { role: "assistant", runId }, "assistant-1"),
      ],
      {
        supportsConversationRollback: true,
        threadStartCheckpointAvailable: true,
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: "checkpoint-1" as never,
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.buttons("Edit from here")).toHaveLength(0);
    await click(screen.button(/^Automation/));
    expect(screen.buttons("Edit from here")).toHaveLength(1);
  });
});

const SENDER_THREAD_ID = ThreadId.make("thread-sender");
const AGENT_MESSAGE = "Review finished\n\nThe migration drops the index before backfilling it.";

describe("MessagesTimeline agent messages", () => {
  it("bounds a long collapsed task preview and reveals its intact details on demand", async () => {
    using _state = setup();
    const opening = "Beendete Gespräche und Transkripte wieder öffnen.";
    const detail = "INTERNAL_TASK_DETAIL ".repeat(150);
    await using screen = await renderTimeline([
      message(`${opening} ${detail}`, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID }),
    ]);
    const row = screen.button(/^Details öffnen: Agentennachricht:/);
    expect(row.textContent).toContain(opening);
    expect(row.textContent).not.toContain("INTERNAL_TASK_DETAIL");
    expect(row.getBoundingClientRect().height).toBeLessThan(100);
    const body = screen.container.querySelector<HTMLElement>(
      "[data-agent-message] [data-thread-find-text]",
    )!;
    expect(body.checkVisibility()).toBe(false);
    await click(row);
    expect(body.checkVisibility()).toBe(true);
    expect(body.textContent).toContain(detail.trim());
  });

  it("folds a message from another agent and keeps its sender link available", async () => {
    using _state = setup();
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      { onOpenThread },
    );
    const row = screen.button(/^Details öffnen: Agentennachricht:/);
    const body = screen.container.querySelector<HTMLElement>(
      "[data-agent-message] [data-thread-find-text]",
    )!;
    expect(row.textContent).toContain("Review finished");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(body.checkVisibility()).toBe(false);
    const sender = screen.container.querySelector<HTMLAnchorElement>(
      'a[aria-label^="Absenderthread öffnen:"]',
    )!;
    expect(decodeURIComponent(sender.getAttribute("href")!)).toContain(
      `/${ENVIRONMENT_ID}/${SENDER_THREAD_ID}`,
    );
    expect(sender.checkVisibility()).toBe(true);

    await click(row);
    await vi.waitFor(() => expect(body.checkVisibility()).toBe(true));
    expect(body.textContent).toContain("The migration drops the index before backfilling it.");
    await click(screen.button("Open thread"));
    expect(onOpenThread).toHaveBeenCalledWith(SENDER_THREAD_ID, ENVIRONMENT_ID);

    await click(screen.button(/^Zuklappen: Agentennachricht:/));
    await vi.waitFor(() => expect(body.checkVisibility()).toBe(false));
    expect(sender.checkVisibility()).toBe(true);
  });

  it("keeps a disconnected linked sender's title without offering thread navigation", async () => {
    using _state = setup();
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [
        message(
          "Linked review finished",
          {
            createdBy: "agent",
            linkedSender: {
              environmentId: EnvironmentId.make("environment-linked"),
              threadId: SENDER_THREAD_ID,
              title: "Release lead",
            },
          },
          "message-linked",
        ),
      ],
      { onOpenThread },
    );
    expect(screen.text()).toContain("Release lead");
    expect(screen.buttons("Open thread")).toHaveLength(0);
    expect(screen.container.querySelector('a[aria-label^="Absenderthread öffnen:"]')).toBeNull();

    const body = screen.container.querySelector<HTMLElement>(
      "[data-agent-message] [data-thread-find-text]",
    )!;
    await click(screen.button(/^Details öffnen: Agentennachricht:/));
    await vi.waitFor(() => expect(body.checkVisibility()).toBe(true));
    expect(body.textContent).toContain("Linked review finished");
    expect(screen.buttons("Open thread")).toHaveLength(0);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("leaves messages sent by T3 Code as full bubbles", async () => {
    using _state = setup();
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", creationSource: "server" }),
    ]);
    expect(screen.buttons(/^Details öffnen: Agentennachricht:/)).toHaveLength(0);
    expect(screen.text()).toContain("drops the index");
  });

  it("reveals a find match inside a folded agent message", async () => {
    using _state = setup();
    const text = `${"Checked the next file.\n\n".repeat(16)}The migration drops the index.`;
    await using screen = await renderTimeline(
      [message(text, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      {
        findExpanded: true,
        findQuery: "drops the index",
        activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
      },
    );
    await vi.waitFor(() =>
      expect(screen.button(/^Zuklappen: Agentennachricht:/).getAttribute("aria-expanded")).toBe(
        "true",
      ),
    );
    const { range } = collectThreadFindRanges(screen.container, "drops the index")[0]!;
    const body = screen.container.querySelector("[data-agent-message] [data-thread-find-text]")!;
    expect(range.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      body.getBoundingClientRect().bottom,
    );
  });
});

it("shows current tool intent without repeating public commentary in the live disclosure", async () => {
  using _state = setup();
  const runId = RunId.make("live-intent-run");
  const commentary =
    "I will inspect the recording preferences and check which permission is missing.";
  const intent = "Inspect recording permissions";
  const reasoning = "Focusing on code efficiency";
  const entries: Entry[] = [
    message(commentary, { role: "assistant", runId }),
    {
      id: "reasoning",
      kind: "work",
      createdAt: CREATED_AT,
      entry: {
        id: "reasoning",
        createdAt: CREATED_AT,
        runId,
        label: "Thinking",
        tone: "thinking",
        itemType: "reasoning",
        detail: reasoning,
        toolLifecycleStatus: "completed",
      },
    },
    {
      id: "permission-check",
      kind: "work",
      createdAt: CREATED_AT,
      entry: {
        id: "permission-check",
        createdAt: CREATED_AT,
        runId,
        label: "Run shell commands",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "inProgress",
        structuredPayload: {
          id: TurnItemId.make("permission-check"),
          threadId: ThreadId.make("fixture"),
          runId,
          type: "command_execution",
          input: "# Intent: Inspect recording permissions\npython3 inspect.py",
          title: null,
          status: "running",
        } as import("@t3tools/contracts").OrchestrationV2TurnItem,
      },
    },
  ];
  await using screen = await renderTimeline(entries, {
    isWorking: true,
    runningRunId: runId,
    activeTurnStartedAt: CREATED_AT,
  });
  await expect.element(screen.getByRole("button", { name: new RegExp(intent) })).toBeVisible();
  expect(screen.text().split(commentary)).toHaveLength(2);
  expect(screen.buttons(new RegExp(commentary))).toHaveLength(0);
  expect(screen.buttons(new RegExp(intent))).toHaveLength(1);
  expect(screen.text()).toContain(reasoning);
  expect(screen.button(new RegExp(intent)).getAttribute("aria-expanded")).toBe("false");
  await click(screen.button(new RegExp(intent)));
  await vi.waitFor(() => {
    expect(screen.button(new RegExp(intent)).getAttribute("aria-expanded")).toBe("true");
    expect(screen.text()).toContain(reasoning);
  });
  await click(screen.button(new RegExp(intent)));
  await vi.waitFor(() =>
    expect(screen.button(new RegExp(intent)).getAttribute("aria-expanded")).toBe("false"),
  );
});

describe("MessagesTimeline attachments", () => {
  it.each(["image", "file"] as const)(
    "copies only matching context records for a wordless %s attachment",
    async (kind) => {
      const attachment = {
        type: kind,
        id: "media",
        name: kind === "image" ? "photo.png" : "clip.mp4",
        mimeType: kind === "image" ? "image/png" : "video/mp4",
        sizeBytes: 100,
        downloadable: false,
      };
      const record = {
        version: 1 as const,
        ...(kind === "image" ? { kind: "image" as const } : { kind: "file" as const }),
        contextId: ComposerContextId.make("media-context"),
        label: attachment.name,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      await using screen = await renderTimeline([message("", { attachments: [attachment] })]);
      expect(screen.buttons("Copy message")).toHaveLength(0);
      await screen.rerender(
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("", {
              attachments: [attachment],
              context: { version: 1, records: [{ ...record, attachmentId: "other" }] },
            }),
          ]}
        />,
      );
      expect(screen.buttons("Copy message")).toHaveLength(0);
      await screen.rerender(
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("", {
              attachments: [attachment],
              context: {
                version: 1,
                records: [
                  record,
                  {
                    ...record,
                    contextId: ComposerContextId.make("other-context"),
                    attachmentId: "other",
                  },
                ],
              },
            }),
          ]}
        />,
      );
      using write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
      await click(screen.button("Copy message"));
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      const [item] = write.mock.calls[0]![0];
      const text = await (await item!.getType("text/plain")).text();
      const fragment = await (await item!.getType(COMPOSER_CONTEXT_CLIPBOARD_MIME)).text();
      expect(
        collectComposerContextReferences(text).map((reference) => reference.contextId),
      ).toEqual([record.contextId]);
      expect(decodeComposerContextFragment(fragment)?.records).toEqual([record]);
    },
  );

  it.each(["loadedmetadata", "loadeddata", "canplay"])(
    "plays audio with unknown duration after %s and updates the total later",
    async (readyEvent) => {
      const onOpen = vi.fn();
      const preview = (failed = false) => (
        <AudioPreview
          compact
          src="data:audio/webm;base64,"
          name="recording.webm"
          failed={failed}
          onOpen={onOpen}
        />
      );
      await using screen = await renderElement(<div dir="rtl">{preview()}</div>);
      const audio = screen.container.querySelector("audio")!;
      const duration = vi.spyOn(audio, "duration", "get").mockReturnValue(Infinity);
      const play = vi.spyOn(audio, "play").mockResolvedValue();
      expect(screen.button("Loading recording.webm")).toHaveProperty("disabled", true);
      await act(() => audio.dispatchEvent(new Event(readyEvent)));
      expect(screen.button("Play recording.webm")).toHaveProperty("disabled", false);
      expect(screen.text()).toContain("0:00");
      expect(screen.text()).not.toContain("/");
      await click(screen.button("Play recording.webm"));
      expect(play).toHaveBeenCalledOnce();
      await act(() => {
        vi.spyOn(audio, "currentTime", "get").mockReturnValue(3);
        audio.dispatchEvent(new Event("play"));
        audio.dispatchEvent(new Event("timeupdate"));
      });
      expect(screen.button("Pause recording.webm")).toHaveProperty("disabled", false);
      expect(screen.text()).toContain("0:03");
      const progress = screen.container.querySelector<HTMLElement>("span[aria-hidden]")!;
      expect(progress.style.width).toBe("0%");
      await act(() => {
        duration.mockReturnValue(10);
        audio.dispatchEvent(new Event("durationchange"));
      });
      expect(screen.text()).toContain("0:03 / 0:10");
      expect(
        getComputedStyle(screen.container.querySelector("audio")!.previousElementSibling!)
          .direction,
      ).toBe("ltr");
      expect(progress.style.width).toBe("30%");
      await act(() => {
        duration.mockReturnValue(NaN);
        audio.dispatchEvent(new Event("durationchange"));
      });
      expect(screen.text()).not.toContain("/");
      expect(progress.style.width).toBe("0%");
      expect(screen.button("Pause recording.webm")).toHaveProperty("disabled", false);
      await screen.rerender(preview(true));
      expect(screen.text()).toContain("Unavailable");
      await click(screen.button("Audio unavailable. Open recording.webm"));
      expect(onOpen).toHaveBeenCalledOnce();
    },
  );

  it.each(["pause", "error"])("unpins audio after %s", async (event) => {
    const NativeObserver = IntersectionObserver;
    using _observer = stubGlobal(
      "IntersectionObserver",
      class extends NativeObserver {
        constructor(
          private readonly notify: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) {
          super(notify, options);
        }
        override observe(target: Element) {
          this.notify([{ target, isIntersecting: true } as IntersectionObserverEntry], this);
        }
      },
    );
    const src =
      "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
    stubbedAsset.url = src;
    onTestFinished(() => {
      stubbedAsset.url = "";
    });
    const props = baseProps();
    await using screen = await renderTimeline(
      [
        // The first message row is always mounted, so the recordings go in the second.
        message("Start of the thread.", { role: "user" }, "opening"),
        message(
          "Two recordings.",
          {
            attachments: ["one", "two"].map((name) => ({
              type: "file",
              id: `attachment-${name}`,
              name: `${name}.wav`,
              mimeType: "audio/wav",
              sizeBytes: 45,
              previewUrl: src,
            })),
          },
          "audio",
        ),
        ...Array.from({ length: 40 }, (_, index) =>
          message("Conversation history. ".repeat(40), { role: "user" }, `history-${index}`),
        ),
      ],
      props,
    );
    screen.container.style.height = "600px";
    screen.container.scrollIntoView({ block: "start" });
    await vi.waitFor(
      async () => {
        await act(() => {
          void props.listRef.current?.scrollToIndex({ index: 1, animated: false });
        });
        expect(screen.container.querySelectorAll("audio")).toHaveLength(2);
      },
      { timeout: 5000 },
    );
    const [one, two] = [...screen.container.querySelectorAll("audio")];
    await act(async () => {
      vi.spyOn(one!, "paused", "get").mockReturnValue(false);
      vi.spyOn(two!, "paused", "get").mockReturnValue(false);
      one!.dispatchEvent(new Event("play"));
      two!.dispatchEvent(new Event("play"));
    });
    await vi.waitFor(async () => {
      await act(() => {
        void props.listRef.current!.scrollToEnd({ animated: false });
      });
      const scroll = props.listRef.current!.getScrollableNode()!;
      expect(scroll.scrollTop).toBeGreaterThan(5000);
    });
    expect(one!.isConnected).toBe(true);
    expect(two!.isConnected).toBe(true);
    await act(async () => {
      vi.spyOn(one!, "paused", "get").mockReturnValue(true);
      one!.dispatchEvent(new Event("pause"));
    });
    expect(two!.isConnected).toBe(true);
    await act(async () => {
      if (event === "pause") vi.spyOn(two!, "paused", "get").mockReturnValue(true);
      two!.dispatchEvent(new Event(event));
    });
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 20, animated: false });
    });
    await vi.waitFor(() => expect(one!.isConnected).toBe(false));
  });

  it("opens a viewed image as a gallery of the images beside it", async () => {
    stubbedAsset.url =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    onTestFinished(() => {
      stubbedAsset.url = "";
    });
    const onImageExpand = vi.fn<ComponentProps<typeof MessagesTimeline>["onImageExpand"]>();
    await using screen = await renderElement(
      <TimelineRowCtx
        value={
          {
            threadRef: { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("thread-1") },
            workspaceRoot: "/repo",
            onImageExpand,
          } as never
        }
      >
        <ViewedImagesTimelineRow
          row={{
            kind: "viewed-images",
            id: "viewed",
            createdAt: CREATED_AT,
            paths: ["/repo/first.png", "/repo/second.png", "/repo/third.png"],
          }}
        />
      </TimelineRowCtx>,
    );
    await screen.getByRole("button", { name: "Preview second.png" }).click();
    expect(onImageExpand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: 1,
        images: ["first.png", "second.png", "third.png"].map((name) =>
          expect.objectContaining({ name }),
        ),
      }),
    );
  });

  it("opens an image from an expanded tool row as a gallery of the turn's viewed images", async () => {
    stubbedAsset.url =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    onTestFinished(() => {
      stubbedAsset.url = "";
    });
    const onImageExpand = vi.fn<ComponentProps<typeof MessagesTimeline>["onImageExpand"]>();
    const read = (name: string) =>
      work(`read-${name}`, {
        label: `Read ${name}`,
        toolTitle: "Read",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        viewedImagePath: `/repo/${name}`,
      });
    await using screen = await renderTimeline(
      [read("first.png"), read("second.png"), read("third.png")],
      { onImageExpand, workspaceRoot: "/repo" },
    );
    await click(screen.button(/^Read 3 files/));
    await vi.waitFor(() => expect(screen.buttons("Read")).toHaveLength(3));
    await click(screen.buttons("Read")[1]!);
    const inRow = await vi.waitFor(() => {
      const image = [...screen.container.querySelectorAll("img")].find(
        (img) => img.alt === "second.png" && !img.closest("[data-image-gallery]"),
      );
      expect(image).toBeTruthy();
      return image!;
    });
    await click(inRow.closest<HTMLElement>("button, [role=button]")!);
    expect(onImageExpand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: 1,
        images: ["first.png", "second.png", "third.png"].map((name) =>
          expect.objectContaining({ name }),
        ),
      }),
    );
  });
});

describe("MessagesTimeline thread find", () => {
  // Opening find is navigation; on a list already showing the thread the open
  // action navigates, so the list itself releases follow only when it starts
  // showing a thread whose find is already open.
  function renderObserved() {
    const navigations: TimelineNavigation[] = [];
    const base = baseProps();
    const element = (next: Partial<TimelineProps>) => (
      <MessagesTimeline
        {...base}
        timelineEntries={[message("Where is the sidebar fix?")]}
        onViewportAttach={(viewport) =>
          viewport.subscribe((navigation) => navigations.push(navigation))
        }
        {...next}
      />
    );
    return { navigations, element };
  }
  const released = { source: "command", releasesFollow: true };

  it("releases follow once when it starts showing a thread whose find is open", async () => {
    setup();
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({}));
    expect(navigations).toEqual([]);

    const other = "environment-local:thread-find-open";
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
    await screen.rerender(element({ routeThreadKey: other, findOpen: false }));
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("releases follow once when it mounts on a thread whose find is open", async () => {
    setup();
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({ findOpen: true }));
    await screen.rerender(element({ findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it.each([false, true])(
    "restores reading position and reports its end state (find: %s)",
    async (findOpen) => {
      setup();
      const onIsAtEndChange = vi.fn();
      const base = { ...baseProps(), onIsAtEndChange };
      const other = "environment-local:thread-find-open-positioned";
      const replies = Array.from({ length: 40 }, (_, index) =>
        message(`Reply ${index}\n\n${"line\n\n".repeat(8)}`, { role: "assistant" }, `r-${index}`),
      );
      rememberTimelinePosition(
        other,
        { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
        false,
      );
      await using screen = await renderElement(
        <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
      );
      onIsAtEndChange.mockClear();
      await screen.rerender(
        <MessagesTimeline
          {...base}
          routeThreadKey={other}
          timelineEntries={replies}
          liveFollowEnabled={false}
          findOpen={findOpen}
        />,
      );
      const viewport = base.listRef.current!.getScrollableNode()!;
      await vi.waitFor(() => {
        const row = screen.container.querySelector('[data-timeline-row-id="entry-r-20"]');
        expect(row).not.toBeNull();
        expect(
          Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
        ).toBeLessThanOrEqual(2);
      });
      await vi.waitFor(() => expect(onIsAtEndChange).toHaveBeenLastCalledWith(false));
    },
  );
  it("reveals find's match, not the remembered row, on a thread it switches to", async () => {
    setup();
    const base = baseProps();
    const other = "environment-local:thread-find-open-match";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(
        `${index === 5 ? "Needle here" : `Reply ${index}`}\n\n${"line\n\n".repeat(8)}`,
        { role: "assistant" },
        `r-${index}`,
      ),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
        findExpanded
        findQuery="Needle"
        activeFindMatch={{ entryId: "entry-r-5", runId: null, occurrence: 0 }}
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-5"]');
      expect(row).not.toBeNull();
      const bounds = viewport.getBoundingClientRect();
      const top = row!.getBoundingClientRect().top;
      expect(top).toBeGreaterThanOrEqual(bounds.top);
      expect(top).toBeLessThan(bounds.bottom);
    });
  });
});

describe("compact reasoning math", () => {
  it.each([
    [
      "## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]",
      [
        ["text", "Reasoning Use norm "],
        ["inlineMath", "|x|"],
        ["text", " and "],
        ["inlineMath", "x^2"],
      ],
    ],
    [
      "  Lead   **bold**\n\n   *em*  `code`  \n\n- one\n-   two\n\n> quote\n> more\n\ntrail   ",
      [["text", "Lead bold em code one two quote more trail"]],
    ],
    [
      "$a$ starts, ends with $b$",
      [
        ["inlineMath", "a"],
        ["text", " starts, ends with "],
        ["inlineMath", "b"],
      ],
    ],
    [
      "before   $x$\n\n$$\ny\n$$\n\n   after",
      [
        ["text", "before "],
        ["inlineMath", "x"],
        ["text", " "],
        ["inlineMath", "y"],
        ["text", " after"],
      ],
    ],
    [
      "a *b*$c$**d** e",
      [
        ["text", "a b"],
        ["inlineMath", "c"],
        ["text", "d e"],
      ],
    ],
    [
      "$a$![](x.png)$b$",
      [
        ["inlineMath", "a"],
        ["text", ""],
        ["inlineMath", "b"],
      ],
    ],
    [
      "| a | b |\n| - | - |\n| $x$ | y  z |",
      [
        ["text", "a b "],
        ["inlineMath", "x"],
        ["text", " y z"],
      ],
    ],
    [
      'See [a  link](https://example.com "t") ![alt   text](img.png) <b>bold</b> <!-- c -->\n\n[ref]: https://example.com\n\n:::note\nbody\n:::',
      [["text", "See a link alt text bold :::note body :::"]],
    ],
    [
      "line one\r\nline two\r\n\r\nnext  nbsp　wide 😀𝑥 end",
      [["text", "line one line two next nbsp wide 😀𝑥 end"]],
    ],
    [
      `${"x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 1)}😀 tail`,
      [["text", "x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 1)]],
    ],
    ["\\$5 and \\$6, \\*not em\\*", [["text", "$5 and $6, *not em*"]]],
    ["hard  \nbreak\\\nagain", [["text", "hard break again"]]],
    ["<div>only html</div>", [["text", "Reasoning"]]],
  ])("keeps formulas while flattening compact reasoning previews: %j", (source, expected) => {
    const tree = parseMarkdownWithMath(source);
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => [node.type, "value" in node ? node.value : null])).toEqual(
      expected,
    );
  });

  it("stops reading the tree once the preview is full", () => {
    const beyondCap = (): string => {
      throw new Error("read beyond cap");
    };
    const head = "x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 2);
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: head },
            { type: "strong", children: [{ type: "text", value: "yz beyond" }] },
            {
              type: "inlineMath",
              get value() {
                return beyondCap();
              },
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              get value() {
                return beyondCap();
              },
            },
          ],
        },
      ],
    };
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children).toEqual([{ type: "text", value: `${head}yz` }]);
  });
});

it("renders automatic compaction as one live divider that finishes with its reason and token delta", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture();
  const prompt = fixture.visibleTurnItems[3]!;
  const assistant = fixture.visibleTurnItems[5]!;
  if (prompt.item.type !== "user_message" || assistant.item.type !== "assistant_message") {
    throw new Error("Expected streaming fixture messages");
  }
  const promptItem = prompt.item;
  const compaction = {
    ...assistant,
    item: {
      ...assistant.item,
      type: "compaction" as const,
      driver: null,
      beforeTokenCount: 899_000,
    },
  };
  const entries = (completed: boolean) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          ...prompt,
          item: { ...promptItem, text: "/compact", idleCompaction: "beforeCacheExpires" },
        },
        {
          ...compaction,
          item: {
            ...compaction.item,
            status: completed ? "completed" : "running",
            afterTokenCount: completed ? 19_000 : undefined,
          },
        },
      ],
      optimisticMessages: [],
    });
  const props = baseProps();
  const ui = (completed: boolean) => (
    <MessagesTimeline
      {...props}
      timelineEntries={entries(completed)}
      isWorking={!completed}
      isCompacting={!completed}
      activeTurnStartedAt={fixture.time(5)}
      latestRun={{
        runId: fixture.runId,
        status: completed ? "completed" : "running",
        startedAt: fixture.time(5),
        completedAt: completed ? fixture.time(9) : null,
      }}
    />
  );
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  await using screen = await render(ui(false), { container });
  await expect
    .element(screen.getByRole("separator", { name: "Compacting before the cache expires…" }))
    .toBeVisible();
  expect(container.textContent).not.toContain("/compact");
  expect(container.textContent).not.toContain("Thinking");
  expect(container.textContent).not.toContain("Working");
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  await screen.rerender(ui(true));
  await expect
    .element(
      screen.getByRole("separator", {
        name: "Context automatically compacted before cache expiry 899K → 19K tokens",
      }),
    )
    .toBeVisible();
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(container.textContent).not.toContain("Compacting before");
});

function TimelineChangedFilesCard() {
  const [expanded, setExpanded] = useState(true);
  return (
    <ChangedFilesCard
      runId={RunId.make("run-1")}
      files={["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => ({
        path,
        kind: "modified",
        additions: 1,
        deletions: 0,
      }))}
      totals={{ count: 3, additions: 3, deletions: 0 }}
      allDirectoriesExpanded={expanded}
      resolvedTheme="light"
      onToggleAllDirectories={() => setExpanded((value) => !value)}
      onOpenTurnDiff={() => {}}
    />
  );
}

function ChangedFilesTimeline() {
  return (
    <LegendList
      data={["files", "after"]}
      keyExtractor={(item) => item}
      estimatedItemSize={100}
      recycleItems={false}
      className="h-[600px]"
      renderItem={({ item }) =>
        item === "files" ? <TimelineChangedFilesCard /> : <div data-testid="after">After</div>
      }
    />
  );
}

describe("ChangedFilesCard", () => {
  it.each(["folder", "all folders"])(
    "measures %s collapse and expansion in the same commit",
    async (toggle) => {
      await using screen = await render(<ChangedFilesTimeline />);
      const after = () =>
        screen.container.querySelector('[data-testid="after"]')!.getBoundingClientRect().top;
      const cardBottom = () =>
        screen.container.querySelector("[data-changed-files-state]")!.getBoundingClientRect()
          .bottom;
      await vi.waitFor(() => expect(after()).toBe(cardBottom()));
      const topBefore = after();
      const button = () =>
        screen.container.querySelector<HTMLButtonElement>(
          toggle === "folder"
            ? '[data-changed-file-row="src"] button'
            : 'button[aria-label$="all folders"]',
        )!;
      await act(() => {
        flushSync(() => button().click());
        expect(screen.container.textContent).not.toContain("a.ts");
        expect(after()).toBe(topBefore - 3 * 28);
      });
      await act(() => {
        flushSync(() => button().click());
        expect(screen.container.textContent).toContain("a.ts");
        expect(after()).toBe(topBefore);
      });
    },
  );
});

it("keeps concurrent approvals actionable outside collapsed work and restores settled rows", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture();
  const source = fixture.visibleTurnItems[4]!;
  if (source.item.type !== "dynamic_tool") throw new Error("Expected fixture tool");
  const sourceItem = source.item;
  const commandRequest = RuntimeRequestId.make("command-approval");
  const appRequest = RuntimeRequestId.make("app-approval");
  const approvals: PendingApproval[] = [
    {
      requestId: commandRequest,
      requestKind: "command",
      createdAt: fixture.time(6),
      detail: "printf '" + "long-command ".repeat(80) + "'",
      reason: "Needs permission to run the command",
      fullAccessOverride: "ask_rule",
      responseCapability: "live",
    },
    {
      requestId: appRequest,
      requestKind: "permission",
      createdAt: fixture.time(6),
      detail: "Open the current tab",
      appName: "Safari",
      options: [
        { decision: "decline", label: "Deny" },
        { decision: "accept", label: "Allow once" },
        {
          decision: "acceptAlways",
          label: "Always allow Safari",
          warning: "Applies to future requests",
        },
      ],
      responseCapability: "external",
    },
  ];
  const entries = (completed = false) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        { ...source, item: { ...sourceItem, status: completed ? "completed" : sourceItem.status } },
        ...approvals.map((approval, index) => ({
          ...source,
          position: source.position + index + 1,
          sourceItemId: TurnItemId.make(`approval-${index}`),
          item: {
            ...sourceItem,
            id: TurnItemId.make(`approval-${index}`),
            type: "approval_request" as const,
            status: completed ? ("completed" as const) : ("waiting" as const),
            requestId: approval.requestId,
            requestKind: approval.requestKind,
            prompt: approval.detail,
          },
        })),
      ],
      optimisticMessages: [],
    });
  const props = baseProps();
  const onRespondToApproval = vi.fn(async () => {});
  const ui = (overrides: Partial<TimelineProps> = {}) => (
    <MessagesTimeline
      {...props}
      timelineEntries={entries()}
      pendingApprovals={approvals}
      canOperateThread
      onRespondToApproval={onRespondToApproval}
      isWorking
      runningRunId={fixture.runId}
      {...overrides}
    />
  );
  await using screen = await renderElement(ui());
  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await expect
    .element(screen.getByRole("group", { name: "App permission approval" }))
    .toBeVisible();
  await expect.element(screen.getByText(approvals[0]!.detail!, { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Needs permission to run the command")).toBeVisible();
  await vi.waitFor(() => {
    expect(
      getComputedStyle(screen.getByLabelText("Command", { exact: true }).element()).userSelect,
    ).toBe("text");
    expect(
      getComputedStyle(screen.getByText("Needs permission to run the command").element())
        .userSelect,
    ).toBe("text");
  });
  await expect.element(screen.getByText("Safari", { exact: true })).toBeVisible();
  await click(screen.button("Why am I being asked this?"));
  await expect.element(page.getByText(/an ask rule in the agent's own settings/)).toBeVisible();
  await click(screen.button("Why am I being asked this?"));
  await click(screen.buttons("More approval options")[1]!);
  await expect.element(page.getByRole("menuitem", { name: "Always allow Safari" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Always allow Safari" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "acceptAlways");
  await click(screen.buttons("More approval options")[0]!);
  await expect.element(page.getByRole("menuitem", { name: "Cancel", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Always allow this session" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "acceptForSession");
  await click(screen.button("Decline"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "decline");
  await click(screen.button("Allow once"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "accept");
  for (const timelineEntries of [entries(), []]) {
    await screen.rerender(
      ui({ timelineEntries, heldApprovalRequestIds: new Set([commandRequest]) }),
    );
    await expect
      .element(screen.getByRole("group", { name: "Command approval" }))
      .not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(0));
    await expect
      .element(screen.getByRole("button", { name: "Allow once", exact: true }))
      .toBeVisible();
    await screen.rerender(ui({ timelineEntries }));
    await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
    await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(1));
  }
  await screen.rerender(ui({ timelineEntries: [], isWorking: false }));
  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await click(screen.button("Approve"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "accept");
  await click(screen.button("Deny"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "decline");
  await screen.rerender(
    ui({
      timelineEntries: [],
      isWorking: false,
      pendingApprovals: [{ ...approvals[0]!, detail: "" }],
    }),
  );
  await expect
    .element(screen.getByLabelText("Command", { exact: true }))
    .toHaveTextContent("Command approval");
  await screen.rerender(ui({ canOperateThread: false }));
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await vi.waitFor(() =>
    expect(
      screen.buttons("More approval options").every((button) => button.hasAttribute("disabled")),
    ).toBe(true),
  );
  await screen.rerender(ui({ respondingRequestIds: [commandRequest] }));
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .toBeEnabled();
  await screen.rerender(
    ui({ pendingApprovals: [{ ...approvals[0]!, responseCapability: "not_resumable" }] }),
  );
  await expect
    .element(screen.getByText("Provider process is gone. Interrupt or restart the run to respond."))
    .toBeVisible();
  await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(0));
  await screen.rerender(
    ui({ pendingApprovals: [], timelineEntries: entries(true), isWorking: false }),
  );
  await expect
    .element(screen.getByRole("group", { name: "Command approval" }))
    .not.toBeInTheDocument();
  await vi.waitFor(() => expect(screen.text()).not.toContain("Waiting for approval"));
  await screen.getByRole("button", { expanded: false }).click();
  const completedCommand = screen.getByRole("button", { name: "Command approval", exact: true });
  await expect.element(completedCommand).toBeVisible();
  await completedCommand.click();
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector(
        '[data-v2-item-type="approval_request"] [aria-label="Recorded input"]',
      )?.textContent,
    ).toBe(approvals[0]!.detail),
  );
  await expect
    .element(screen.getByRole("button", { name: "Open the current tab", exact: true }))
    .toBeVisible();
});

it.each([
  { title: null, text: "Cache prüfen.", details: false },
  { title: "Cache prüfen.", text: "Cache prüfen.", details: false },
  { title: null, text: "Read [guide](https://example.com/guide)", details: true },
])(
  "only offers original short provider text when it adds content (title=$title, details=$details)",
  async ({ title, text, details }) => {
    using _state = setup();
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        v2Item("reasoning", {
          title,
          text,
          streaming: false,
          updatedAt: DateTime.makeUnsafe(CREATED_AT),
        }),
      ],
      optimisticMessages: [],
    });
    await using screen = await renderTimeline(entries);
    const fold = screen.buttons(/Worked for/)[0];
    if (fold?.getAttribute("aria-expanded") === "false") await click(fold);
    const row = screen.container.querySelector<HTMLElement>('[data-v2-item-type="reasoning"]');
    if (details) {
      expect(row?.getAttribute("role")).toBe("button");
      await click(row!);
      await expect.element(screen.getByRole("link", { name: "guide" })).toBeVisible();
    } else {
      expect(row?.textContent).toContain(text);
      expect(row?.getAttribute("role")).not.toBe("button");
      expect(row?.hasAttribute("aria-expanded")).toBe(false);
    }
  },
);

it.each([
  { source: "inline", streaming: false },
  { source: "shallow", streaming: false },
  { source: "inline", streaming: true },
  { source: "shallow", streaming: true },
] as const)(
  "keeps the summary and opens the original for $source reasoning (streaming=$streaming)",
  async ({ source, streaming }) => {
    using _state = setup();
    const runId = RunId.make("original-reasoning-run");
    const summary = "Der Shell-Wrapper wird geprüft, bevor die Ausführung geändert wird.";
    const original = "Inspect the existing shell wrapper before choosing an executor change.";
    const prefix = "Inspect the existing shell wrapper";
    const delayedTitle = source === "shallow" && streaming;
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 2, 17, 19, 12, 0, second * 1_000)).toISOString());
    const item = (
      text: string,
      live: boolean,
      second: number,
    ): import("@t3tools/contracts").OrchestrationV2ProjectedTurnItem =>
      v2Item("reasoning", {
        id: "original-reasoning",
        runId,
        title: delayedTitle && live && second < 29 ? null : summary,
        text,
        status: live ? "running" : "completed",
        streaming: live,
        updatedAt: at(second),
        startedAt: at(28),
        completedAt: live ? null : at(second),
      });
    const entries = (text: string, live: boolean, second: number) =>
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [item(source === "shallow" ? "" : text, live, second)],
        optimisticMessages: [],
      });
    environmentQuery.error = "";
    const initialText = streaming ? prefix : original;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const responses = Atom.family((revision: string) =>
      Atom.make<
        AsyncResult.AsyncResult<
          import("@t3tools/contracts").OrchestrationV2GetTurnItemResult,
          unknown
        >
      >(
        AsyncResult.initial<import("@t3tools/contracts").OrchestrationV2GetTurnItemResult, unknown>(
          true,
        ),
      ).pipe(Atom.keepAlive, Atom.withLabel(revision)),
    );
    const revision = (live: boolean, second: number) =>
      live
        ? `live:${Math.floor(DateTime.toEpochMillis(at(second)) / 1_000)}`
        : DateTime.formatIso(at(second));
    registry.set(
      responses(revision(streaming, 28)),
      AsyncResult.success({ item: item(initialText, streaming, 28).item }),
    );
    const detail = vi.fn<NonNullable<TimelineProps["turnItemSource"]>["detail"]>((input) => {
      const response = responses(input.revision);
      environmentQuery.sources.add(response);
      return response;
    });
    const props = {
      ...baseProps(),
      turnItemSource: {
        detail,
        commandOutput: vi.fn<NonNullable<TimelineProps["turnItemSource"]>["commandOutput"]>(),
      },
    };
    const draw = (text: string, live: boolean, second: number, otherThread = false) => (
      <RegistryContext.Provider value={registry}>
        <MessagesTimeline
          {...props}
          routeThreadKey={otherThread ? "other-thread" : props.routeThreadKey}
          timelineEntries={otherThread ? [] : entries(text, live, second)}
          isWorking={live}
          runningRunId={live ? runId : null}
          latestRun={{
            runId,
            status: live ? "running" : "completed",
            startedAt: CREATED_AT,
            completedAt: live ? null : CREATED_AT,
          }}
        />
      </RegistryContext.Provider>
    );
    await using screen = await renderElement(draw(initialText, streaming, 28));
    const openOriginal = async (label = summary) => {
      const fold = screen.buttons(/Worked for/)[0];
      if (fold?.getAttribute("aria-expanded") === "false") await click(fold);
      const toggle = screen.getByRole("button", { name: new RegExp(label) });
      await expect.element(toggle).toBeVisible();
      if (toggle.element().getAttribute("aria-expanded") !== "true") await toggle.click();
    };
    await openOriginal(delayedTitle ? "Thinking" : summary);
    await vi.waitFor(() => expect(screen.text()).toContain(initialText));
    if (source === "shallow") {
      expect(detail).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
        itemId: TurnItemId.make("original-reasoning"),
        revision: streaming
          ? `live:${Math.floor(DateTime.toEpochMillis(at(28)) / 1_000)}`
          : DateTime.formatIso(at(28)),
      });
    } else {
      expect(detail).not.toHaveBeenCalled();
    }
    if (streaming) {
      if (source === "shallow") {
        await screen.rerender(draw(prefix, true, 28.5));
        expect(new Set(detail.mock.calls.map(([input]) => input.revision)).size).toBe(1);
        await screen.rerender(draw(prefix, true, 29));
        await vi.waitFor(() => expect(screen.text()).toContain(prefix));
        expect(screen.text()).not.toContain("Loading provider text");
        expect(screen.text()).not.toContain(original);
      }
      if (source === "shallow") {
        await act(() =>
          registry.set(
            responses(revision(true, 29)),
            AsyncResult.success({ item: item(original, true, 29).item }),
          ),
        );
      } else {
        await screen.rerender(draw(original, true, 29));
      }
      await vi.waitFor(() => expect(screen.text()).toContain(original));
      if (source === "shallow") {
        expect(detail).toHaveBeenCalledWith({
          threadId: ThreadId.make("thread-1"),
          itemId: TurnItemId.make("original-reasoning"),
          revision: `live:${Math.floor(DateTime.toEpochMillis(at(29)) / 1_000)}`,
        });
      }
    }
    registry.set(
      responses(revision(false, 30)),
      AsyncResult.success({ item: item(original, false, 30).item }),
    );
    await screen.rerender(draw(original, false, 30));
    await openOriginal();
    await vi.waitFor(() => expect(screen.text()).toContain(original));
    expect(screen.text()).toContain(summary);
    if (source === "shallow")
      expect(detail).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
        itemId: TurnItemId.make("original-reasoning"),
        revision: DateTime.formatIso(at(30)),
      });
    await screen.rerender(draw(original, false, 30, true));
    expect(screen.text()).not.toContain(original);
    await screen.rerender(draw(original, false, 30));
    await openOriginal();
    await vi.waitFor(() => expect(screen.text()).toContain(original));
    expect(screen.text()).toContain(summary);
  },
);
