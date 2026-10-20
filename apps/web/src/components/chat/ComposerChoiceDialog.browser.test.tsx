import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { ComposerChoiceDialog } from "./ComposerChoiceDialog";

let root: Root;
let container: HTMLDivElement;
let draft: HTMLTextAreaElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  draft = document.createElement("textarea");
  draft.value = "Keep my draft and caret";
  document.body.append(draft, container);
  draft.focus();
  draft.setSelectionRange(5, 8);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  draft.remove();
  vi.unstubAllGlobals();
});

async function mountPicker() {
  const selected = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <ComposerChoiceDialog
        title="Reasoning"
        choices={["Low", "Medium", "High"].map((label) => ({
          id: label,
          label,
          selected: label === "Medium",
          onSelect: () => selected(label),
        }))}
        emptyMessage="Unavailable"
        onClose={() => setOpen(false)}
        restoreFocus={() => draft.focus()}
      />
    ) : null;
  }
  await act(async () => root.render(<Harness />));
  const input = await vi.waitFor(() => {
    const element = document.querySelector<HTMLInputElement>('input[aria-label="Reasoning"]');
    if (!element || document.activeElement !== element)
      throw new Error("Picker search not focused");
    return element;
  });
  return { input, selected };
}

it("filters and selects an option while preserving the original draft selection", async () => {
  const { input, selected } = await mountPicker();
  await act(async () => {
    await userEvent.fill(input, "high");
  });
  await act(async () => {
    await userEvent.keyboard("{Enter}");
  });
  expect(selected).toHaveBeenCalledExactlyOnceWith("High");
  await vi.waitFor(() => expect(document.activeElement).toBe(draft));
  expect(draft.value).toBe("Keep my draft and caret");
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([5, 8]);
});

it("navigates with Ctrl+N/P and cancels without changing the selection", async () => {
  const { input, selected } = await mountPicker();
  await act(async () => {
    await userEvent.keyboard("{Control>}n{/Control}");
  });
  await vi.waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBeTruthy());
  const next = input.getAttribute("aria-activedescendant");
  await act(async () => {
    await userEvent.keyboard("{Control>}p{/Control}");
  });
  await vi.waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBe(next));
  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });
  expect(selected).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.activeElement).toBe(draft));
});
