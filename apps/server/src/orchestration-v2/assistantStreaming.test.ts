import { MessageId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { assert, describe, expect, it, vi } from "vite-plus/test";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";

import { TurnItemId } from "@t3tools/contracts";
import { NodeId } from "@t3tools/contracts";
const message = (text: string, streaming = true): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "message.updated",
  driver: ProviderDriverKind.make("codex"),
  message: {
    id: MessageId.make("message"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    createdBy: "agent",
    creationSource: "provider",
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    role: "assistant",
    text,
    attachments: [],
    createdAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    streaming,
  },
});

const turnItem = (
  text: string,
  streaming = true,
  type: "assistant_message" | "reasoning" = "assistant_message",
): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver: ProviderDriverKind.make("codex"),
  turnItem: {
    id: TurnItemId.make("item"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: streaming ? "running" : "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    ...(type === "assistant_message" ? { type, messageId: MessageId.make("message") } : { type }),
    text,
    streaming,
  },
});

describe("V2 assistant streaming", () => {
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
    expect(splitBufferedAssistantText("```a``` is inline.\n\n```\ncode\n\nmore\n")).toEqual({
      ready: "```a``` is inline.\n\n",
      rest: "```\ncode\n\nmore\n",
    });
  });
  it("holds streaming text until the full response completes", () => {
    const running = message("partial");
    const final = message("complete", false);
    const buffered = makeAssistantStreamingFilter("turn");
    expect(buffered.filter(running, 0)).toBeNull();
    expect(buffered.filter(message("First\n\nSecond\n\n"), 500)).toBeNull();
    expect(buffered.filter(final, 501)).toBe(final);
  });

  it("streams complete native visual records before the fence closes", () => {
    const opening = "```t3-ui\n";
    const chart = '{"type":"chart","id":"c","title":"Test"}\n';
    const point = '{"type":"point","id":"c","label":"Day 1","value":12}\n';
    const partial = '{"type":"point","id":"c","label":"Day 2","value":1';
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter.filter(turnItem(opening + chart + partial), 0)).toMatchObject({
      turnItem: { text: opening + chart, streaming: true },
    });
    expect(filter.filter(turnItem(opening + chart + point + partial), 100)).toBeNull();
    expect(filter.filter(turnItem(opening + chart + point + partial), 400)).toMatchObject({
      turnItem: { text: opening + chart + point, streaming: true },
    });
    const final = turnItem(opening + chart + point + "```", false);
    expect(filter.filter(final, 401)).toBe(final);
    expect(makeAssistantStreamingFilter("turn").filter(turnItem(opening + chart), 0)).toBeNull();
  });

  it.each(["```t3-ui", "~~~~t3-ui", "  ```t3-ui"])(
    "uses terminated record boundaries within %s fences",
    (opening) => {
      const ready = `${opening}\n{"type":"metric","id":"m","label":"Value","value":12}\n`;
      const partial = '{"type":"row","id":"t","cells":[1';
      expect(splitBufferedAssistantText(ready + partial)).toEqual({ ready, rest: partial });
    },
  );

  it("does not stream ordinary code or nested visual-looking text inside code", () => {
    for (const opening of ["```json", "```t3-ui-example", "```t3-ui extra"]) {
      const text = `${opening}\n{"type":"metric","value":12}\n`;
      expect(splitBufferedAssistantText(text)).toEqual({ ready: "", rest: text });
    }
    const nested = '````text\n```t3-ui\n{"type":"metric","value":12}\n';
    expect(splitBufferedAssistantText(nested)).toEqual({ ready: "", rest: nested });
  });

  it.each(["assistant_message", "reasoning"] as const)(
    "buffers assistant responses while preserving live provider reasoning (%s)",
    (type) => {
      const item = (text: string, streaming = true) => turnItem(text, streaming, type);
      const filter = makeAssistantStreamingFilter("paragraph");
      const first = item("First");
      expect(filter.filter(first, 0)).toBe(type === "reasoning" ? first : null);
      expect(filter.filter(item("First\n\nSec"), 410)).toMatchObject({
        turnItem: {
          text: type === "reasoning" ? "First\n\nSec" : "First\n\n",
          streaming: true,
          type,
        },
      });
      expect(filter.filter(item("First\n\nSecond\n\nThi"), 510)).toBeNull();
      expect(filter.filter(item("First\n\nSecond\n\nThi"), 810)).toMatchObject({
        turnItem: {
          text: type === "reasoning" ? "First\n\nSecond\n\nThi" : "First\n\nSecond\n\n",
          streaming: true,
        },
      });
      const final = item("First\n\nSecond\n\nThird", false);
      expect(filter.filter(final, 820)).toBe(final);

      const buffered = makeAssistantStreamingFilter("turn");
      const partial = item("First\n\nSecond");
      expect(buffered.filter(partial, 0)).toBe(type === "reasoning" ? partial : null);
      expect(buffered.filter(final, 1)).toBe(final);
    },
  );

  it.each(["turn", "paragraph"] as const)(
    "suppresses running assistant nodes in %s mode while delivering tool and completed nodes",
    (mode) => {
      const filter = makeAssistantStreamingFilter(mode);
      const running: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> = {
        type: "node.updated",
        driver: ProviderDriverKind.make("codex"),
        node: {
          id: NodeId.make("node"),
          threadId: ThreadId.make("thread"),
          runId: null,
          parentNodeId: null,
          rootNodeId: NodeId.make("root"),
          kind: "assistant_message",
          status: "running",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: null,
        },
      };
      expect(filter.filter(running, 0)).toBeNull();
      const completed = { ...running, node: { ...running.node, status: "completed" as const } };
      expect(filter.filter(completed, 1)).toBe(completed);
      const tool = { ...running, node: { ...running.node, kind: "tool_call" as const } };
      expect(filter.filter(tool, 2)).toBe(tool);
    },
  );
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});

type Step =
  // A snapshot at `at` ms, and the text it delivers at once (null when held back).
  | { readonly at: number; readonly text: string; readonly shows: string | null }
  | { readonly at: number; readonly final: string }
  | { readonly id: string; readonly at: number; readonly text: string; readonly shows: string }
  // Held snapshots due by `idle` ms, delivered whole.
  | { readonly idle: number; readonly shows: ReadonlyArray<string> }
  | { readonly dueAt: number | null };

const createdAt = DateTime.makeUnsafe(0);
const snapshot = (id: string, text: string, streaming: boolean) =>
  ({
    type: "message.updated",
    driver: ProviderDriverKind.make("codex"),
    message: {
      createdBy: "agent",
      creationSource: "provider",
      id: MessageId.make(id),
      threadId: ThreadId.make("thread"),
      runId: null,
      nodeId: null,
      role: "assistant",
      text,
      attachments: [],
      streaming,
      createdAt,
      updatedAt: createdAt,
    },
  }) satisfies ProviderAdapter.ProviderAdapterV2Event;
const shown = (event: ProviderAdapter.ProviderAdapterV2Event | null) =>
  event?.type === "message.updated" ? event.message.text : null;

it.each<{ readonly name: string; readonly mode?: "turn"; readonly steps: ReadonlyArray<Step> }>([
  {
    name: "an unfinished code fence",
    steps: [
      { at: 0, text: "A\n\n```ts\nx()", shows: "A\n\n" },
      { dueAt: 800 },
      { idle: 799, shows: [] },
      { idle: 800, shows: ["A\n\n```ts\nx()"] },
      { dueAt: null },
      { at: 1_300, text: "A\n\n```ts\nx()\n```\n\nB", shows: "A\n\n```ts\nx()\n```\n\n" },
    ],
  },
  {
    name: "a list's partial last item",
    steps: [
      { at: 0, text: "Steps:\n\n- one\n- tw", shows: "Steps:\n\n- one\n" },
      { idle: 800, shows: ["Steps:\n\n- one\n- tw"] },
      { at: 1_300, text: "Steps:\n\n- one\n- two\n- th", shows: "Steps:\n\n- one\n- two\n" },
    ],
  },
  {
    name: "an incomplete table row",
    steps: [
      { at: 0, text: "Intro.\n\n| a | b |\n|---|---|\n| 1 |", shows: "Intro.\n\n" },
      { idle: 800, shows: ["Intro.\n\n| a | b |\n|---|---|\n| 1 |"] },
      {
        at: 1_300,
        text: "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter",
        shows: "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n",
      },
    ],
  },
  {
    name: "more of the same paragraph after an idle delivery",
    steps: [
      { at: 0, text: "A\n\nB", shows: "A\n\n" },
      { idle: 800, shows: ["A\n\nB"] },
      { at: 900, text: "A\n\nB more", shows: null },
      { idle: 1_699, shows: [] },
      { idle: 1_700, shows: ["A\n\nB more"] },
      { idle: 5_000, shows: [] },
      // Its only boundary is behind what the idle delivery showed.
      { at: 5_100, text: "A\n\nB more and", shows: null },
      { at: 5_200, text: "A\n\nB more and.\n\nC", shows: "A\n\nB more and.\n\n" },
      { at: 5_300, final: "A\n\nB more and.\n\nC." },
      { idle: 10_000, shows: [] },
    ],
  },
  {
    name: "completion at the idle deadline",
    steps: [
      { at: 0, text: "A\n\nB", shows: "A\n\n" },
      { at: 800, final: "A\n\nB." },
      { idle: 800, shows: [] },
    ],
  },
  {
    name: "completion right after an idle delivery at the same instant",
    steps: [
      { at: 0, text: "A\n\nB", shows: "A\n\n" },
      { idle: 800, shows: ["A\n\nB"] },
      { at: 800, final: "A\n\nB." },
      { idle: 5_000, shows: [] },
    ],
  },
  {
    name: "several fast paragraphs inside the throttle",
    steps: [
      { at: 0, text: "A\n\nB", shows: "A\n\n" },
      { at: 100, text: "A\n\nB\n\nC", shows: null },
      { at: 200, text: "A\n\nB\n\nC\n\nD", shows: null },
      { at: 300, text: "A\n\nB\n\nC\n\nD\n\nE", shows: null },
      { idle: 1_099, shows: [] },
      { idle: 1_100, shows: ["A\n\nB\n\nC\n\nD\n\nE"] },
    ],
  },
  {
    name: "two messages due at different times",
    steps: [
      { id: "a", at: 0, text: "A\n\nx", shows: "A\n\n" },
      { id: "b", at: 300, text: "B\n\ny", shows: "B\n\n" },
      { dueAt: 800 },
      { idle: 800, shows: ["A\n\nx"] },
      { dueAt: 1_100 },
      { idle: 1_100, shows: ["B\n\ny"] },
    ],
  },
  {
    name: "empty text",
    steps: [{ at: 0, text: "", shows: null }, { dueAt: null }],
  },
  {
    name: "whitespace-only text",
    steps: [
      { at: 0, text: " \n", shows: null },
      { idle: 800, shows: [" \n"] },
      { idle: 5_000, shows: [] },
    ],
  },
  {
    // Rewrites replace delivered text: shorter at once, same length after the throttle.
    name: "provider rewrites and truncation",
    steps: [
      { at: 0, text: "Original long paragraph.\n\n", shows: "Original long paragraph.\n\n" },
      { at: 1_000, text: "New.\n\n", shows: "New.\n\n" },
      { at: 1_100, text: "Old.\n\n", shows: null },
      { idle: 1_900, shows: ["Old.\n\n"] },
      { at: 2_500, text: "Old", shows: null },
      { idle: 3_300, shows: ["Old"] },
      { at: 4_000, text: "", shows: null },
      { idle: 4_800, shows: [""] },
    ],
  },
  {
    name: "a rewrite that drops an open code fence",
    steps: [
      { at: 0, text: "Intro\n\n```ts\nx()\n", shows: "Intro\n\n" },
      { at: 400, text: "Retry\n\n- a\n- b", shows: "Retry\n\n- a\n" },
    ],
  },
  {
    name: "turn mode",
    mode: "turn",
    steps: [{ at: 0, text: "A\n\nB", shows: null }, { dueAt: null }],
  },
])("paragraph streaming holds and idle-delivers $name", ({ mode, steps }) => {
  const filter = makeAssistantStreamingFilter(mode ?? "paragraph", 800);
  for (const step of steps) {
    if ("dueAt" in step) assert.equal(filter.nextIdleFlushAt(), step.dueAt);
    else if ("idle" in step)
      assert.deepEqual(filter.takeIdleFlushes(step.idle).map(shown), [...step.shows]);
    else if ("final" in step)
      assert.equal(shown(filter.filter(snapshot("m", step.final, false), step.at)), step.final);
    else
      assert.equal(
        shown(filter.filter(snapshot("id" in step ? step.id : "m", step.text, true), step.at)),
        step.shows,
      );
  }
});

it("scans each streamed line once while a long code fence is still open", () => {
  const filter = makeAssistantStreamingFilter("paragraph", 800);
  const lineCount = 400;
  let text = "Intro\n\n```ts\n";
  const indexOf = vi.spyOn(String.prototype, "indexOf");
  try {
    for (let line = 0; line < lineCount; line++) {
      text += `const value${line} = ${line};\n`;
      filter.filter(snapshot("m", text, true), line * 400);
    }
    const newlineSearches = indexOf.mock.calls.filter(([search]) => search === "\n").length;
    expect(newlineSearches).toBeLessThan(lineCount * 4);
  } finally {
    indexOf.mockRestore();
  }
  text += "```\n";
  assert.equal(shown(filter.filter(snapshot("m", text, true), lineCount * 400)), text);
});
