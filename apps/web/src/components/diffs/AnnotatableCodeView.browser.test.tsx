import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "~/composerDraftStore";
import { AnnotatableCodeView } from "./AnnotatableCodeView";
import "~/index.css";

it("selects diff lines with the keyboard and creates a real comment draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  host.style.cssText = "display:flex;width:800px;height:480px";
  const root = createRoot(host);
  const target = scopeThreadRef(
    EnvironmentId.make("diff-keyboard"),
    ThreadId.make("diff-keyboard"),
  );
  const fileDiff = parsePatchFiles(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n same\n last\n",
  )[0]!.files[0]!;
  const viewer = vi.fn();
  try {
    await act(async () =>
      root.render(
        <AnnotatableCodeView
          codeViewKey="keyboard-diff"
          viewerRef={viewer}
          files={[{ fileKey: "a", filePath: "a.ts", fileDiff, fileVersion: 0, collapsed: false }]}
          sectionId="test"
          sectionTitle="Test diff"
          composerDraftTarget={target}
          options={{}}
          renderHeaderFilenameSuffix={() => null}
          renderHeaderPrefix={() => null}
          onRevealSearchMatch={() => {}}
        />,
      ),
    );
    await vi.waitFor(() =>
      expect(viewer).toHaveBeenCalledWith(
        expect.objectContaining({ scrollTo: expect.any(Function) }),
      ),
    );
    const region = host.querySelector<HTMLElement>('[aria-label="Test diff code"]')!;
    region.focus();
    await act(async () =>
      region.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }),
      ),
    );
    await act(async () =>
      region.dispatchEvent(
        new KeyboardEvent("keydown", { key: "J", shiftKey: true, bubbles: true, cancelable: true }),
      ),
    );
    expect(host.querySelector('[role="status"]')?.textContent).toContain("a.ts:2–3");
    await act(async () =>
      region.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }),
      ),
    );
    await vi.waitFor(() => expect(host.querySelector("textarea")).not.toBeNull());
    const textarea = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Keyboard review",
    );
    await act(async () => textarea.dispatchEvent(new Event("input", { bubbles: true })));
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
    expect(
      useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments.at(-1),
    ).toMatchObject({ text: "Keyboard review", filePath: "a.ts" });
    expect(document.activeElement).toBe(region);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useComposerDraftStore.getState().clearDraftThread(target);
    vi.unstubAllGlobals();
  }
});
