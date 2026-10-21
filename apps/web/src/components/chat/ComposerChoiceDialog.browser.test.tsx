import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { ComposerChoiceDialog } from "./ComposerChoiceDialog";
import { act, render } from "../../../test/render";
import {
  requestNavigationMode,
  isNavigationMode,
  leaveNavigationMode,
} from "../keyboard/navigationMode";

function setup() {
  const draft = document.createElement("textarea");
  draft.value = "Keep my draft and caret";
  document.body.append(draft);
  draft.focus();
  draft.setSelectionRange(5, 8);
  return {
    draft,
    [Symbol.dispose]() {
      draft.remove();
      leaveNavigationMode();
    },
  };
}

async function mountPicker(draft: HTMLTextAreaElement) {
  await using resources = new AsyncDisposableStack();
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
        restoreFocus={() => draft}
      />
    ) : null;
  }
  resources.use(await render(<Harness />));
  const input = await vi.waitFor(() => {
    const element = document.querySelector<HTMLInputElement>('input[aria-label="Reasoning"]');
    if (!element || document.activeElement !== element)
      throw new Error("Picker search not focused");
    return element;
  });
  const cleanup = resources.move();
  return { input, selected, [Symbol.asyncDispose]: () => cleanup[Symbol.asyncDispose]() };
}

it("filters and selects an option while preserving the original draft selection", async () => {
  using fixture = setup();
  const { draft } = fixture;
  await using screen = await mountPicker(draft);
  const { input, selected } = screen;
  await userEvent.fill(input, "high");
  await userEvent.keyboard("{Enter}");
  expect(selected).toHaveBeenCalledExactlyOnceWith("High");
  await vi.waitFor(() => expect(document.activeElement).toBe(draft));
  expect(draft.value).toBe("Keep my draft and caret");
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([5, 8]);
});

it("navigates with Ctrl+N/P and cancels without changing the selection", async () => {
  using fixture = setup();
  const { draft } = fixture;
  await using screen = await mountPicker(draft);
  const { input, selected } = screen;
  await userEvent.keyboard("{Control>}n{/Control}");
  await vi.waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBeTruthy());
  const next = input.getAttribute("aria-activedescendant");
  await userEvent.keyboard("{Control>}p{/Control}");
  await vi.waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBe(next));
  await userEvent.keyboard("{Escape}");
  expect(selected).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.activeElement).toBe(draft));
});

it("returns to navigation through successive settings choices without inserting leader keys", async () => {
  using fixture = setup();
  const { draft } = fixture;
  using resources = new DisposableStack();
  const target = document.createElement("button");
  resources.defer(() => target.remove());
  target.textContent = "Selected message";
  document.body.append(target);
  target.focus();
  requestNavigationMode();
  const changes = vi.fn();
  const settings = ["Model", "Reasoning", "Service tier", "Access"];
  function Settings() {
    const [index, setIndex] = useState(0);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open settings</button>
        {!open ? null : (
          <ComposerChoiceDialog
            title={settings[index]!}
            choices={[
              {
                id: "current",
                label: "Current choice",
                selected: true,
                onSelect: () => {
                  changes(settings[index]);
                  setIndex(index + 1);
                },
              },
            ]}
            emptyMessage="Unavailable"
            onClose={() => setOpen(false)}
            restoreFocus={() => {
              requestNavigationMode();
              return target;
            }}
          />
        )}
      </>
    );
  }
  await using screen = await render(<Settings />);
  for (let index = 0; index < settings.length; index += 1) {
    await act(async () => {
      screen.container.querySelector<HTMLButtonElement>("button")!.click();
    });
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(settings[index]),
    );
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(document.activeElement).toBe(target));
    expect(isNavigationMode()).toBe(true);
    expect(draft.value).toBe("Keep my draft and caret");
  }
  expect(changes).toHaveBeenCalledTimes(4);
});
