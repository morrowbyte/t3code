import "../../index.css";
import type { CDPSession } from "@vitest/browser-playwright";
import { useRef } from "react";
import { cdp, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { ImageAnnotationEditor } from "./ImageAnnotationEditor";
import { exportAnnotatedImage, loadAnnotationImage } from "./ImageAnnotation";
import { sendImageAnnotation } from "./ImageAnnotationSend";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

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
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent) === name,
  )!;

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
          renderImage={(overlay, drawing) => (
            <ZoomableImage
              ref={zoom}
              src={src}
              name="touch.png"
              onError={() => {}}
              overlay={overlay}
              drawing={drawing}
            />
          )}
        />
      );
    }
    // The editor has no navigation context.
    await using screen = await render(<TouchEditor />, { router: false });
    const container = screen.container;
    const canvas = container.querySelector("canvas")!;
    await vi.waitFor(() => expect(canvas.width).toBe(160));
    const session: CDPSession = cdp();
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await session.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      try {
        await act(async () => {
          await session.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [from],
          });
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [to] });
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        });
      } finally {
        await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      }
    };
    const stroke = async () => {
      const box = canvas.getBoundingClientRect();
      const frame = window.frameElement?.getBoundingClientRect();
      const touch = (fraction: number) => ({
        x: (frame?.left ?? 0) + box.left + box.width * fraction,
        y: (frame?.top ?? 0) + box.top + box.height * fraction,
      });
      await drag(touch(0.25), touch(0.75));
    };
    await userEvent.click(button(container, "Thick stroke"));
    const beforeWidth = canvas.getBoundingClientRect().width;
    await stroke();
    expect(canvas.getContext("2d")!.getImageData(80, 50, 1, 1).data[3]).toBeGreaterThan(0);
    await userEvent.click(button(container, "Undo mark"));
    await userEvent.click(button(container, "Zoom in"));
    expect(canvas.getBoundingClientRect().width).toBeGreaterThan(beforeWidth);
    await stroke();
    await userEvent.click(button(container, "Send annotation"));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const marked = await pixel(onSend.mock.calls[0]![0], 80, 50);
    expect(marked[1]).toBeLessThan(200);
    expect(await pixel(onSend.mock.calls[0]![0], 10, 90)).toEqual([255, 255, 255, 255]);

    container.style.setProperty("--media-width", "120px");
    await userEvent.click(button(container, "Move"));
    expect(button(container, "Move").getAttribute("aria-pressed")).toBe("true");
    const marks = canvas.getContext("2d")!.getImageData(0, 0, 160, 100).data;
    const viewer = container.querySelector<HTMLElement>('[role="region"]')!;
    await vi.waitFor(() => expect(viewer.scrollWidth).toBeGreaterThan(viewer.clientWidth));
    const bounds = viewer.getBoundingClientRect();
    const frame = window.frameElement?.getBoundingClientRect();
    const x = (frame?.left ?? 0) + bounds.left + 90;
    const y = (frame?.top ?? 0) + bounds.top + 40;
    const beforeScroll = viewer.scrollLeft;
    await drag({ x, y }, { x: x - 60, y });
    expect(viewer.scrollLeft).toBeGreaterThan(beforeScroll);
    expect(canvas.getContext("2d")!.getImageData(0, 0, 160, 100).data).toEqual(marks);
    await userEvent.click(button(container, "Draw"));
    expect(button(container, "Draw").getAttribute("aria-pressed")).toBe("true");
    expect(canvas.style.pointerEvents).toBe("");
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
    // The editor has no navigation context.
    await using screen = await render(
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
      { router: false },
    );
    const container = screen.container;
    const canvas = container.querySelector("canvas")!;
    await vi.waitFor(() => expect(canvas.width).toBe(160));
    await userEvent.click(canvas, { position: { x: 80.5, y: 50.5 } });
    expect(button(container, "Send annotation").disabled).toBe(false);
    await userEvent.click(button(container, "Undo mark"));
    expect(button(container, "Send annotation").disabled).toBe(true);
    expect([...canvas.getContext("2d")!.getImageData(80, 50, 1, 1).data]).toEqual([0, 0, 0, 0]);
    await userEvent.click(canvas, { position: { x: 80.5, y: 50.5 } });
    await userEvent.click(button(container, "Clear marks"));
    expect(button(container, "Send annotation").disabled).toBe(true);
    await userEvent.click(button(container, "Cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.click(canvas, { position: { x: 80.5, y: 50.5 } });
    await userEvent.type(container.querySelector("textarea")!, "Please check this.");
    await userEvent.dblClick(button(container, "Send annotation"));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0]?.[1]).toBe("Please check this.");
    expect(button(container, "Sending…").disabled).toBe(true);
    await act(() => resolve(false));
    expect(container.querySelector("textarea")?.value).toBe("Please check this.");
    expect(button(container, "Send annotation").disabled).toBe(false);
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
