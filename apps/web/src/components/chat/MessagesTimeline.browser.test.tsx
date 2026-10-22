import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import { MessagesTimeline, remarkThoughtPreview } from "./MessagesTimeline";
import { LeaderNavigation } from "../keyboard/LeaderNavigation";
import { leaveNavigationMode } from "../keyboard/navigationMode";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";

const pullRequestQuery = vi.hoisted(() => ({ error: "Pull request not found" }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: pullRequestQuery.error,
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

function setup(): Disposable {
  pullRequestQuery.error = "Pull request not found";
  leaveNavigationMode();
  return { [Symbol.dispose]: leaveNavigationMode };
}

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

describe("MessagesTimeline messages", () => {
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
