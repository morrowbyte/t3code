import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { StrictMode, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import "~/index.css";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileDiffIdentityKey } from "~/lib/diffRendering";

type ViewerProps = Extract<
  ComponentProps<typeof StyledDiffCodeView<unknown>>,
  { items: readonly unknown[] }
>;

const viewerMode = vi.hoisted(() => ({ fake: true }));

// Replace only the virtualized viewer; comment editing and submission use the real components.
vi.mock("./StyledDiffCodeView", async (original) => {
  const actual = await original<typeof import("./StyledDiffCodeView")>();
  return {
    ...actual,
    StyledDiffCodeView: (props: ViewerProps) =>
      !viewerMode.fake ? (
        <actual.StyledDiffCodeView {...props} />
      ) : (
        props.items
          ?.filter((item) => item.type === "diff")
          .map((item) => (
            <section key={item.id}>
              <button
                disabled={
                  !props.options?.enableLineSelection || !props.options?.enableGutterUtility
                }
                onClick={() => {
                  props.onSelectedLinesChange?.({ id: item.id, range });
                  props.options?.onGutterUtilityClick?.(range, { item });
                }}
              >
                Comment on {item.fileDiff.name}
              </button>
              {props.selectedLines?.id === item.id ? (
                <mark>Line {props.selectedLines.range.start}</mark>
              ) : null}
              {item.annotations?.map((annotation) => (
                <div key={`${annotation.side}:${annotation.lineNumber}`}>
                  {props.renderAnnotation?.(annotation, item)}
                </div>
              ))}
            </section>
          ))
      ),
  };
});

import { AnnotatableCodeView } from "./AnnotatableCodeView";
import type { StyledDiffCodeView } from "./StyledDiffCodeView";

const target = DraftId.make("diff-draft-test");
const range: SelectedLineRange = { start: 1, end: 1, side: "additions" };

function file(
  name: string,
  fileVersion = 1,
  type: FileDiffMetadata["type"] = "change",
  prevName?: string,
) {
  const fileDiff = parsePatchFiles(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`,
    name,
  )[0]!.files[0]!;
  fileDiff.type = type;
  if (prevName) fileDiff.prevName = prevName;
  return {
    fileDiff,
    filePath: name,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion,
    collapsed: false,
  };
}

function view(
  files: ReturnType<typeof file>[],
  codeViewKey = "initial",
  pendingFiles: FileDiffMetadata[] = [],
) {
  return (
    <StrictMode>
      <AnnotatableCodeView
        codeViewKey={codeViewKey}
        files={files}
        pendingFiles={pendingFiles}
        sectionId="unstaged"
        sectionTitle="Uncommitted"
        composerDraftTarget={target}
        options={{}}
        renderHeaderFilenameSuffix={() => null}
        renderHeaderPrefix={() => null}
        onRevealSearchMatch={() => {}}
      />
    </StrictMode>
  );
}

function click(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return act(() => button.click());
}

function editor(container: HTMLElement) {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Comment editor is not available");
  return textarea;
}

function typeComment(container: HTMLElement, text: string) {
  return act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      editor(container),
      text,
    );
    editor(container).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setup(fake = true): Disposable {
  const reset = () => useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  reset();
  viewerMode.fake = fake;
  return { [Symbol.dispose]: reset };
}

describe("diff comment drafts", () => {
  it("keeps the text and selected line through refresh and a provisional lazy patch", async () => {
    using _drafts = setup();
    const container = document.createElement("div");
    const original = file("shared.ts", 1, "rename-pure", "old.ts");
    await using screen = await render(view([original]), { container });
    await click(container, "Comment on shared.ts");
    await typeComment(container, "Keep this draft");
    const refreshed = file("shared.ts", 2, "rename-pure", "old.ts");
    await screen.rerender(view([refreshed], "refreshed"));
    expect(editor(container).value).toBe("Keep this draft");
    expect(container.querySelector("mark")?.textContent).toBe("Line 1");

    await screen.rerender(
      view([], "loading", [
        { ...refreshed.fileDiff, type: "rename-changed", hunks: [], cacheKey: "shared:pending" },
      ]),
    );
    expect(container.querySelector("textarea")).toBeNull();
    await screen.rerender(view([refreshed], "loaded"));
    expect(editor(container).value).toBe("Keep this draft");
    expect(container.querySelector("mark")?.textContent).toBe("Line 1");
    await click(container, "Comment");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({
        filePath: "shared.ts",
        text: "Keep this draft",
        selection: { ...range, endSide: "additions" },
      }),
    ]);
    expect(container.querySelector("p")?.textContent).toBe("Keep this draft");
  });
});

it("selects diff lines with the keyboard and creates a real comment draft", async () => {
  using _drafts = setup(false);
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:480px";
  const target = scopeThreadRef(
    EnvironmentId.make("diff-keyboard"),
    ThreadId.make("diff-keyboard"),
  );
  const fileDiff = parsePatchFiles(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n same\n last\n",
  )[0]!.files[0]!;
  const viewer = vi.fn();
  await using _screen = await render(
    <AnnotatableCodeView
      codeViewKey="keyboard-diff"
      viewerRef={viewer}
      pendingFiles={[]}
      files={[{ fileKey: "a", filePath: "a.ts", fileDiff, fileVersion: 0, collapsed: false }]}
      sectionId="test"
      sectionTitle="Test diff"
      composerDraftTarget={target}
      options={{}}
      renderHeaderFilenameSuffix={() => null}
      renderHeaderPrefix={() => null}
      onRevealSearchMatch={() => {}}
    />,
    { container: host },
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
  await act(async () => {
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(
    useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments.at(-1),
  ).toMatchObject({ text: "Keyboard review", filePath: "a.ts" });
  expect(document.activeElement).toBe(region);
});
