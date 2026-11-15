import type { Editor } from "@tiptap/core";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { flatToMarkdown, pmToFlat, serializeEditorDoc } from "~/composer-rich-text-doc";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";
import { LeaderNavigation } from "./keyboard/LeaderNavigation";
import { act, fakeTimers, render } from "../../test/render";
import { leaveNavigationMode } from "./keyboard/navigationMode";

const draft =
  "> **Assistant and reasoning text still save intermediate full snapshots**, using the existing 50 ms batching. Compaction still preserves their `turn-item.updated` events. [Code](/Users/yashsingh/p/projects/t3code/apps/server/src/orchestration-v2/ProjectionMaintenance.ts:235)";

async function mountEditor(
  value: string,
  richTextEnabled = true,
  onCommandKeyDown: (key: string, event: KeyboardEvent) => boolean = () => false,
) {
  await using resources = new AsyncDisposableStack();
  resources.defer(leaveNavigationMode);
  const screen = resources.use(
    await render(
      <div data-chat-composer-main-surface="true">
        <ComposerPromptEditor
          editorRef={createRef<ComposerPromptEditorHandle>()}
          value={value}
          cursor={0}
          richTextEnabled={richTextEnabled}
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder=""
          onChange={() => {}}
          onPaste={() => {}}
          onCommandKeyDown={onCommandKeyDown}
        />
      </div>,
    ),
  );
  const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  const cleanup = resources.move();
  return {
    editor: element.editor,
    container: screen.container,
    [Symbol.asyncDispose]: () => cleanup[Symbol.asyncDispose](),
  };
}

it("leaves the composer with Escape, opens navigation with Space and returns with i", async () => {
  await using screen = await mountEditor("Keep my draft");
  const { editor } = screen;
  await using _navigation = await render(
    <LeaderNavigation groups={[]} isClaimed={() => false} showSidebar={() => {}} />,
  );
  await act(async () => {
    editor.view.focus();
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(document.activeElement).not.toBe(editor.view.dom);
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
  });
  await vi.waitFor(() =>
    expect(
      document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]'),
    ).not.toBeNull(),
  );
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true }),
    );
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
  expect(serializeEditorDoc(editor.state.doc).value).toBe("Keep my draft");
});

it("lets suggestions consume Escape before leaving the composer", async () => {
  const handler = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  await using screen = await mountEditor("@file", true, handler);
  const { editor } = screen;
  await act(async () => {
    editor.view.focus();
    expect(press(editor, "Escape")).toBe(true);
  });
  expect(document.activeElement).toBe(editor.view.dom);
  await act(async () => expect(press(editor, "Escape")).toBe(true));
  expect(document.activeElement).not.toBe(editor.view.dom);
  expect(serializeEditorDoc(editor.state.doc).value).toBe("@file");
});

it.each([
  { isComposing: true },
  { keyCode: 229 },
  { repeat: true },
  { ctrlKey: true },
  { metaKey: true },
  { altKey: true },
  { shiftKey: true },
])("keeps composer focus for composing, repeated or modified Escape: %j", async (options) => {
  await using screen = await mountEditor("Keep my draft");
  const { editor } = screen;
  await act(async () => {
    editor.view.focus();
    expect(press(editor, "Escape", options)).toBe(false);
  });
  expect(document.activeElement).toBe(editor.view.dom);
});

function press(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, ...options });
  const handled = editor.view.props.handleKeyDown?.(editor.view, event);
  expect(event.defaultPrevented).toBe(Boolean(handled));
  return handled;
}

function markdownOffset(editor: Editor) {
  const map = serializeEditorDoc(editor.state.doc);
  return flatToMarkdown(map, pmToFlat(map, editor.state.selection.head));
}

async function focusAt(editor: Editor, position: number | "end") {
  // ProseMirror's deferred focus rewrite must settle before native arrow navigation.
  using _timers = fakeTimers();
  await act(async () => {
    editor.commands.focus(position);
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
  vi.runOnlyPendingTimers();
}

it("keeps Up before the opening bold marker in a quote, including while typing", async () => {
  await using screen = await mountEditor(draft);
  const { editor } = screen;
  await focusAt(editor, editor.state.selection.from);
  expect(markdownOffset(editor)).toBe("> ".length);
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  await vi.waitFor(() => expect(markdownOffset(editor)).toBe("> ".length));
  await userEvent.keyboard("x");
  await vi.waitFor(() =>
    expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> x**")),
  );
});

it("keeps Down after a closing marker, including while typing", async () => {
  await using screen = await mountEditor("> **bold**");
  const { editor } = screen;
  await focusAt(editor, "end");
  expect(markdownOffset(editor)).toBe("> **bold**".length);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  await vi.waitFor(() => expect(markdownOffset(editor)).toBe("> **bold**".length));
  await userEvent.keyboard("x");
  await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe("> **bold**x"));
});

it("leaves vertical navigation between paragraphs to the browser", async () => {
  await using screen = await mountEditor("**first**\n**second**");
  const { editor } = screen;
  await act(async () => {
    const first = editor.state.doc.child(0);
    editor.commands.setTextSelection(first.nodeSize + 1);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.setTextSelection(first.nodeSize - 1);
    expect(press(editor, "ArrowDown")).toBe(false);
  });
});

it.each([
  { shiftKey: true },
  { altKey: true },
  { metaKey: true },
  { ctrlKey: true },
  { isComposing: true },
])("preserves modified Up behavior for %j", async (options) => {
  await using screen = await mountEditor(draft);
  const { editor } = screen;
  await act(async () => {
    editor.commands.setTextSelection(editor.state.selection.from + "**".length);
    expect(markdownOffset(editor)).toBe("> **".length);
    const position = editor.state.selection.from;
    expect(press(editor, "ArrowUp", options)).toBe(false);
    expect(editor.state.selection.from).toBe(position);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});

it("leaves literal Markdown navigation to the browser in plain mode", async () => {
  await using screen = await mountEditor(draft, false);
  const { editor } = screen;
  await act(async () => {
    editor.commands.setTextSelection(5);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});
