import "../../index.css";
import { useRef, type CSSProperties } from "react";
import { expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { ImageAnnotationEditor } from "./ImageAnnotationEditor";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

it("keeps marks while moving a zoomed image and returns to drawing", async () => {
  const original = document.createElement("canvas");
  original.width = 1200;
  original.height = 900;
  const src = original.toDataURL();
  function Editor() {
    const zoom = useRef<ZoomableImageHandle>(null);
    return (
      <ImageAnnotationEditor
        src={src}
        name="screenshot.png"
        onCancel={vi.fn()}
        onSend={async () => false}
        onZoom={(factor) => zoom.current?.zoom(factor)}
        onFit={() => zoom.current?.fit()}
        renderImage={(overlay, drawing) => (
          <ZoomableImage
            ref={zoom}
            src={src}
            name="screenshot.png"
            onError={vi.fn()}
            overlay={overlay}
            drawing={drawing}
            reservedHeight={340}
          />
        )}
      />
    );
  }
  // The editor has no navigation or thread context.
  await using screen = await render(
    <div
      style={
        {
          "--media-width": "500px",
          position: "fixed",
          inset: 0,
          overflow: "hidden",
        } as CSSProperties
      }
    >
      <Editor />
    </div>,
    { router: false },
  );
  const canvasLocator = screen.getByRole("img", { name: "Draw on image" });
  await vi.waitFor(() => expect((canvasLocator.element() as HTMLCanvasElement).width).toBe(1200));
  const canvas = canvasLocator.element() as HTMLCanvasElement;
  const image = screen.container.querySelector("img")!;
  await vi.waitFor(() => expect(image.naturalWidth).toBe(1200));
  await userEvent.click(canvas);
  const marks = canvas.getContext("2d")!.getImageData(0, 0, 1200, 900).data;
  expect(marks.some((value) => value > 0)).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await expect.element(screen.getByText("225% zoom", { exact: true })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Move", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Move", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  const viewer = screen.getByRole("region", { name: "screenshot.png, zoomable image" }).element();
  await vi.waitFor(() => expect(viewer.scrollWidth).toBeGreaterThan(viewer.clientWidth));
  const bounds = viewer.getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect();
  const x = (frame?.left ?? 0) + bounds.left + 150;
  const y = (frame?.top ?? 0) + bounds.top + 150;
  const before = viewer.scrollLeft;
  const session = cdp();
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    await act(async () => {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x - 80, y: y - 80 }],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
  expect(viewer.scrollLeft).toBeGreaterThan(before);
  expect(canvas.getContext("2d")!.getImageData(0, 0, 1200, 900).data).toEqual(marks);
  await userEvent.click(screen.getByRole("button", { name: "Draw", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Draw", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  expect(canvas.style.pointerEvents).toBe("");
});
