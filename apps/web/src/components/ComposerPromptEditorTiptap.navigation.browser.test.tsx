import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { LeaderNavigation } from "./keyboard/LeaderNavigation";

const draft =
  "> **Assistant and reasoning text still save intermediate full snapshots**, using the existing 50 ms batching. Compaction still preserves their `turn-item.updated` events. [Code](/Users/yashsingh/p/projects/t3code/apps/server/src/orchestration-v2/ProjectionMaintenance.ts:235)";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mountEditor(
  value: string,
  richTextEnabled = true,
  onCommandKeyDown?: (key: string, event: KeyboardEvent) => boolean,
) {
  await act(async () =>
    root.render(
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
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

it("leaves the composer with Escape, opens navigation with Space and returns with i", async () => {
  const editor = await mountEditor("Keep my draft");
  const navigationHost = document.createElement("div");
  container.append(navigationHost);
  const navigationRoot = createRoot(navigationHost);
  try {
    await act(async () =>
      navigationRoot.render(
        <LeaderNavigation groups={[]} isClaimed={() => false} showSidebar={() => {}} />,
      ),
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
  } finally {
    await act(async () => navigationRoot.unmount());
  }
});

it("lets suggestions consume Escape before leaving the composer", async () => {
  const handler = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  const editor = await mountEditor("@file", true, handler);
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
  const editor = await mountEditor("Keep my draft");
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

it("keeps Up before the opening bold marker in a quote, including while typing", async () => {
  const editor = await mountEditor(draft);
  const position = editor.state.selection.from;
  await act(async () => {
    editor.view.focus();
    expect(press(editor, "ArrowUp")).toBe(true);
    expect(editor.state.selection.from).toBe(position);
    editor.view.updateState(editor.state);
    const marker = editor.view.dom.querySelector(".composer-rich-marker");
    const caret = window.getSelection()?.getRangeAt(0);
    if (!marker || !caret) throw new Error("Caret or bold marker is missing");
    const markerRange = document.createRange();
    markerRange.selectNode(marker);
    expect(caret.compareBoundaryPoints(Range.START_TO_START, markerRange)).toBeLessThanOrEqual(0);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> x**"));
});

it("keeps Down after a closing marker, including while typing", async () => {
  const editor = await mountEditor("> **bold**");
  await act(async () => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    expect(press(editor, "ArrowDown")).toBe(true);
    expect(press(editor, "ArrowDown")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("> **bold**x");
});

it("leaves vertical navigation between paragraphs to the browser", async () => {
  const editor = await mountEditor("**first**\n**second**");
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
  const editor = await mountEditor(draft);
  await act(async () => {
    expect(press(editor, "ArrowUp", options)).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});

it("leaves literal Markdown navigation to the browser in plain mode", async () => {
  const editor = await mountEditor(draft, false);
  await act(async () => {
    editor.commands.setTextSelection(5);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});
