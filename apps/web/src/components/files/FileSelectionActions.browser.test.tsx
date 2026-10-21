import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "~/composerDraftStore";
import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { FileSelectionActions } from "./FileSelectionActions";

it("quotes and comments an explicitly selected source range using only keyboard-accessible controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const target = scopeThreadRef(
    EnvironmentId.make("source-actions"),
    ThreadId.make("source-actions"),
  );
  const insert = vi.fn((text: string) => text.length >= 0);
  const composer = { current: { insertTextAtEnd: insert } } as unknown as ComposerHandleRef;
  const value = async (input: HTMLInputElement | HTMLTextAreaElement, text: string) => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, text);
    await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
  };
  try {
    await act(async () =>
      root.render(
        <ComposerHandleContext value={composer}>
          <FileSelectionActions
            filePath="src/a.ts"
            contents={"first\nsecond\nthird"}
            composerDraftTarget={target}
          />
        </ComposerHandleContext>,
      ),
    );
    host.querySelector("details")!.open = true;
    await value(host.querySelector<HTMLInputElement>('[aria-label="Selection start line"]')!, "2");
    await value(host.querySelector<HTMLInputElement>('[aria-label="Selection end line"]')!, "3");
    expect(host.querySelector('[aria-label="Selected source lines"]')?.textContent).toBe(
      "second\nthird",
    );
    const buttons = [...host.querySelectorAll("button")];
    await act(async () =>
      buttons.find((button) => button.textContent === "Quote selection")!.click(),
    );
    expect(insert).toHaveBeenCalledWith(expect.stringContaining("second\nthird"));
    expect(insert.mock.lastCall?.[0]).not.toContain("first");
    await act(async () =>
      buttons.find((button) => button.textContent === "Comment selection")!.click(),
    );
    const textarea = host.querySelector("textarea")!;
    await value(textarea, "Check these two lines");
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const comments = useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments;
    expect(comments?.at(-1)).toMatchObject({
      filePath: "src/a.ts",
      diff: "second\nthird",
      text: "Check these two lines",
    });
    expect(document.activeElement).toBe(host.querySelector("summary"));
  } finally {
    await act(async () => root.unmount());
    useComposerDraftStore.getState().clearDraftThread(target);
    host.remove();
    vi.unstubAllGlobals();
  }
});
