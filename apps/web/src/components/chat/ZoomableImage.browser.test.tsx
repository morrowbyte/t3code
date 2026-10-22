import "../../index.css";
import { createRef, type CSSProperties } from "react";
import { cdp } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

it.each([false, true])("reserves left drag for the annotation overlay: %s", async (annotating) => {
  const original = document.createElement("canvas");
  original.width = 1200;
  original.height = 800;
  const handle = createRef<ZoomableImageHandle>();
  const onError = vi.fn();
  // This standalone image has no route or app-state dependencies.
  await using screen = await render(
    <div style={{ "--media-width": "500px" } as CSSProperties}>
      <ZoomableImage
        ref={handle}
        src={original.toDataURL()}
        name="Drawing fixture"
        onError={onError}
        overlay={
          annotating ? <canvas className="absolute inset-0 h-full w-full touch-none" /> : undefined
        }
      />
    </div>,
    { router: false },
  );
  const image = screen.container.querySelector("img")!;
  await vi.waitFor(() => expect(image.naturalWidth).toBe(1200));
  await act(() => handle.current!.zoom(3));
  const viewport = screen.container.querySelector<HTMLElement>('[role="region"]')!;
  expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
  const before = viewport.scrollLeft;
  const box = viewport.getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect();
  const x = (frame?.left ?? 0) + box.left + box.width / 2;
  const y = (frame?.top ?? 0) + box.top + box.height / 2;
  const session = cdp();
  await act(async () => {
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    try {
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x - 80,
        y,
        button: "left",
        buttons: 1,
      });
    } finally {
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: x - 80,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
  });
  if (annotating) expect(viewport.scrollLeft).toBe(before);
  else expect(viewport.scrollLeft).toBeGreaterThan(before + 40);
  expect(onError).not.toHaveBeenCalled();
});
