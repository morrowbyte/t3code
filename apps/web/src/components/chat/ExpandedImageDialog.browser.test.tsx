import "../../index.css";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { ExpandedImageDialogHost, openExpandedImagePreview } from "./ExpandedImageDialog";

let root: Root;
let container: HTMLDivElement;

const preview = {
  images: [
    { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "one.png" },
    { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "two.png" },
  ],
  index: 0,
};

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

const host = (threadKey: string) => (
  <AppAtomRegistryProvider>
    <ExpandedImageDialogHost threadKey={threadKey} />
  </AppAtomRegistryProvider>
);

const dialog = () => document.querySelector('[role="dialog"]');

describe("ExpandedImageDialogHost", () => {
  it("waits for the send receipt and aborts a leaving editor without closing another thread's preview", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 160, 100);
    const image = { images: [{ src: canvas.toDataURL(), name: "editable.png" }], index: 0 };
    let resolve: (accepted: boolean) => void = () => {};
    let signal: AbortSignal | undefined;
    const onSend = vi.fn((_file: File, _text: string, attempt: AbortSignal) => {
      signal = attempt;
      return new Promise<boolean>((done) => {
        resolve = done;
      });
    });
    await act(() =>
      root.render(
        <AppAtomRegistryProvider>
          <ExpandedImageDialogHost threadKey="env:a" onSendAnnotation={onSend} />
        </AppAtomRegistryProvider>,
      ),
    );
    await act(() => openExpandedImagePreview("env:a", image));
    const annotate = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Annotate",
    )!;
    await act(() => userEvent.click(annotate));
    const overlay = document.querySelector<HTMLCanvasElement>(
      'canvas[aria-label="Draw on image"]',
    )!;
    await vi.waitFor(() => expect(overlay.width).toBe(160));
    await act(() => userEvent.click(overlay));
    const send = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Send annotation",
    )!;
    await act(() => userEvent.click(send));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    await act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelector('[aria-label="Image annotation editor"]')).not.toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')?.disabled,
    ).toBe(true);
    await act(() => root.render(host("env:b")));
    expect(signal?.aborted).toBe(true);
    await act(() => openExpandedImagePreview("env:b", preview));
    await act(() => resolve(true));
    expect(dialog()?.textContent).toContain("one.png (1/2)");
    await act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
  });

  it("opens for its thread, steps with arrows, and closes on Escape with focus back on the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    await act(() => root.render(host("env:a")));
    opener.focus();

    await act(() => openExpandedImagePreview("env:a", preview));
    expect(dialog()?.textContent).toContain("one.png (1/2)");

    await act(() => {
      dialog()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(dialog()?.textContent).toContain("two.png (2/2)");

    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("ignores another thread's preview and drops its own when the thread changes", async () => {
    await act(() => root.render(host("env:a")));
    await act(() => openExpandedImagePreview("env:b", preview));
    expect(dialog()).toBeNull();

    await act(() => openExpandedImagePreview("env:a", preview));
    expect(dialog()).not.toBeNull();

    await act(() => root.render(host("env:b")));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});
