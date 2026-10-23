import { EnvironmentId, MessageId, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, Profiler, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import { remarkThoughtPreview } from "./TimelineWorkEntryRow.logic";
import { LeaderNavigation } from "../keyboard/LeaderNavigation";
import { leaveNavigationMode } from "../keyboard/navigationMode";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { collectThreadFindRanges } from "./threadFindHighlights";
import type { VoiceConversationItem } from "@t3tools/client-runtime/live-voice";

const environmentQuery = vi.hoisted(() => ({
  error: "Pull request not found",
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
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
    onManualNavigation: () => {},
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

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container });
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

it("shows the initiating agent identity and a link on the initial message", async () => {
  using _state = setup();
  const senderThreadId = ThreadId.make("thread:initial-message-sender");
  await using screen = await renderTimeline([
    message("Check the cloud interface", {
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId,
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
    `/${ENVIRONMENT_ID}/${senderThreadId}`,
  );
  expect(link.querySelector("[data-agent-identity]")).not.toBeNull();
  expect(link.textContent?.trim()).toMatch(/\S+\s+\S+/u);
  expect(screen.container.textContent).not.toContain("nicht erfasst");
});

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

describe("MessagesTimeline messages", () => {
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
        threadStartCheckpointReady: true,
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
    const row = screen.button("Details öffnen: Agentennachricht");
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
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID }),
    ]);
    const row = screen.button("Details öffnen: Agentennachricht");
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

    await click(screen.button("Zuklappen: Agentennachricht"));
    await vi.waitFor(() => expect(body.checkVisibility()).toBe(false));
    expect(sender.checkVisibility()).toBe(true);
  });

  it("leaves messages sent by T3 Code as full bubbles", async () => {
    using _state = setup();
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", creationSource: "server" }),
    ]);
    expect(screen.buttons("Details öffnen: Agentennachricht")).toHaveLength(0);
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
      expect(screen.button("Zuklappen: Agentennachricht").getAttribute("aria-expanded")).toBe(
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

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});
