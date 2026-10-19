import "../../index.css";
import type { CDPSession } from "@vitest/browser-playwright";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { cdp, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ImageAnnotationEditor } from "./ImageAnnotationEditor";
import { exportAnnotatedImage, loadAnnotationImage } from "./ImageAnnotation";
import { sendImageAnnotation } from "./ImageAnnotationSend";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

let root: Root;
let container: HTMLDivElement;
function original() {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 100;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 160, 100);
  return canvas.toDataURL("image/png");
}
async function pixel(file: Blob, x: number, y: number) {
  const image = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  image.close();
  return [...ctx.getImageData(x, y, 1, 1).data];
}
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent) === name,
  )!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("image annotation", () => {
  it("maps trusted touch strokes through the existing zoom and exports them in original image space", async () => {
    const src = original();
    const onSend = vi.fn(async (_file: File) => false);
    function TouchEditor() {
      const zoom = useRef<ZoomableImageHandle>(null);
      return (
        <ImageAnnotationEditor
          src={src}
          name="touch.png"
          onCancel={() => {}}
          onSend={onSend}
          onZoom={(factor) => zoom.current?.zoom(factor)}
          onFit={() => zoom.current?.fit()}
          renderImage={(overlay) => (
            <ZoomableImage
              ref={zoom}
              src={src}
              name="touch.png"
              onError={() => {}}
              overlay={overlay}
            />
          )}
        />
      );
    }
    await act(() => root.render(<TouchEditor />));
    const canvas = container.querySelector("canvas")!;
    await vi.waitFor(() => expect(canvas.width).toBe(160));
    const session: CDPSession = cdp();
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const stroke = async () => {
      const box = canvas.getBoundingClientRect();
      const frame = window.frameElement?.getBoundingClientRect();
      const touch = (fraction: number) => ({
        x: (frame?.left ?? 0) + box.left + box.width * fraction,
        y: (frame?.top ?? 0) + box.top + box.height * fraction,
      });
      await act(() =>
        session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [touch(0.25)],
        }),
      );
      await act(() =>
        session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touch(0.75)] }),
      );
      await act(() =>
        session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
      );
    };
    try {
      await act(() => userEvent.click(button("Thick stroke")));
      const beforeWidth = canvas.getBoundingClientRect().width;
      await stroke();
      expect(canvas.getContext("2d")!.getImageData(80, 50, 1, 1).data[3]).toBeGreaterThan(0);
      await act(() => userEvent.click(button("Undo mark")));
      await act(() => userEvent.click(button("Zoom in")));
      expect(canvas.getBoundingClientRect().width).toBeGreaterThan(beforeWidth);
      await stroke();
      await act(() => userEvent.click(button("Send annotation")));
      await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
      const marked = await pixel(onSend.mock.calls[0]![0], 80, 50);
      expect(marked[1]).toBeLessThan(200);
      expect(await pixel(onSend.mock.calls[0]![0], 10, 90)).toEqual([255, 255, 255, 255]);
    } finally {
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
  });

  it("exports the visible marks into new raster pixels and leaves original bytes unchanged", async () => {
    const src = original();
    const before = await (await fetch(src)).arrayBuffer();
    const loaded = await loadAnnotationImage(src, new AbortController().signal);
    const file = await exportAnnotatedImage(
      loaded.image,
      [{ color: "#ef4444", width: 0.08, points: [{ x: 0.5, y: 0.5 }] }],
      "shot.png",
    );
    expect(file.name).toBe("shot-annotated.png");
    expect(file.type).toBe("image/png");
    expect(await pixel(file, 80, 50)).toEqual([239, 68, 68, 255]);
    expect(await pixel(file, 10, 10)).toEqual([255, 255, 255, 255]);
    expect(await (await fetch(src)).arrayBuffer()).toEqual(before);
    await expect(exportAnnotatedImage(loaded.image, [], "shot.png")).rejects.toThrow("Add a mark");
    loaded.dispose();
  });

  it("supports Undo, Clear and Cancel without sending; one explicit send stays locked until its receipt", async () => {
    const src = original();
    let resolve: (accepted: boolean) => void = () => {};
    const onSend = vi.fn<(file: File, text: string, signal: AbortSignal) => Promise<boolean>>(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const onCancel = vi.fn();
    await act(() =>
      root.render(
        <ImageAnnotationEditor
          src={src}
          name="shot.png"
          renderImage={(overlay) => (
            <div style={{ position: "relative", width: 160, height: 100 }}>
              <img src={src} alt="Original" />
              <div style={{ position: "absolute", inset: 0 }}>{overlay}</div>
            </div>
          )}
          onZoom={() => {}}
          onFit={() => {}}
          onCancel={onCancel}
          onSend={onSend}
        />,
      ),
    );
    const canvas = container.querySelector("canvas")!;
    await vi.waitFor(() => expect(canvas.width).toBe(160));
    await act(() => userEvent.click(canvas));
    expect(button("Send annotation").disabled).toBe(false);
    await act(() => userEvent.click(button("Undo mark")));
    expect(button("Send annotation").disabled).toBe(true);
    expect([...canvas.getContext("2d")!.getImageData(80, 50, 1, 1).data]).toEqual([0, 0, 0, 0]);
    await act(() => userEvent.click(canvas));
    await act(() => userEvent.click(button("Clear marks")));
    expect(button("Send annotation").disabled).toBe(true);
    await act(() => userEvent.click(button("Cancel")));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    await act(() => userEvent.click(canvas));
    await act(() => userEvent.type(container.querySelector("textarea")!, "Please check this."));
    await act(() => userEvent.dblClick(button("Send annotation")));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0]?.[1]).toBe("Please check this.");
    expect(button("Sending…").disabled).toBe(true);
    await act(() => resolve(false));
    expect(container.querySelector("textarea")?.value).toBe("Please check this.");
    expect(button("Send annotation").disabled).toBe(false);
    const marked = await pixel(onSend.mock.calls[0]![0], 80, 50);
    expect(marked[0]).toBeGreaterThan(marked[1]!);
    expect(marked[1]).toBeLessThan(255);
  });

  it.each([true, false, "throw"] as const)(
    "isolates the parent draft through send result %s and cleans up its own draft",
    async (outcome) => {
      const store = useComposerDraftStore.getState();
      const parent = DraftId.make("annotation-parent-test");
      store.setPrompt(parent, "Unsent parent text\nwith original spacing.");
      const file = new File([await (await fetch(original())).blob()], "marked.png", {
        type: "image/png",
      });
      const parentImage = {
        type: "image" as const,
        id: "parent-image",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
        previewUrl: URL.createObjectURL(file),
      };
      store.addImages(parent, [parentImage]);
      const parentBefore = store.getComposerDraft(parent);
      let ownDraft: DraftId | undefined;
      const result = sendImageAnnotation({
        file,
        text: "Annotation caption",
        signal: new AbortController().signal,
        isCurrent: () => true,
        send: async (submission) => {
          ownDraft = submission.draftTarget;
          expect(submission.draftTarget).not.toBe(parent);
          expect(store.getComposerDraft(submission.draftTarget)?.images).toHaveLength(1);
          expect(submission.image.source).toBeUndefined();
          expect(submission.text).toBe("Annotation caption");
          if (outcome === "throw") throw new Error("Upload failed");
          return outcome;
        },
      });
      if (outcome === "throw") await expect(result).rejects.toThrow("Upload failed");
      else expect(await result).toBe(outcome);
      expect(store.getComposerDraft(parent)).toBe(parentBefore);
      expect(await (await fetch(parentImage.previewUrl)).arrayBuffer()).toEqual(
        await file.arrayBuffer(),
      );
      expect(store.getComposerDraft(ownDraft!)).toBeNull();
      store.clearDraftThread(parent);
    },
  );

  it("does not send when preparation spans a route, environment or permission change, or an abort", async () => {
    const file = new File([await (await fetch(original())).blob()], "marked.png", {
      type: "image/png",
    });
    for (const aborted of [false, true]) {
      const controller = new AbortController();
      let reads = 0;
      const send = vi.fn(async () => true);
      expect(
        await sendImageAnnotation({
          file,
          text: "Caption",
          signal: controller.signal,
          isCurrent: () => {
            reads += 1;
            if (aborted) controller.abort();
            return reads === 1;
          },
          send,
        }),
      ).toBe(false);
      expect(send).not.toHaveBeenCalled();
    }
  });
});
