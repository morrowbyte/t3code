import "../../index.css";
import type { SnapShotSource } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  ExpandedImageDialog,
  ExpandedImageDialogHost,
  openExpandedImagePreview,
} from "./ExpandedImageDialog";
import { retainThreadOverlaysForThread } from "./threadOverlayRetention";

const preview = {
  images: [
    { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "one.png" },
    { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "two.png" },
  ],
  index: 0,
};

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
    using _overlays = { [Symbol.dispose]: () => retainThreadOverlaysForThread(null) };
    await using screen = await render(
      <AppAtomRegistryProvider>
        <ExpandedImageDialogHost threadKey="env:a" onSendAnnotation={onSend} />
      </AppAtomRegistryProvider>,
    );
    await act(() => openExpandedImagePreview("env:a", image));
    const annotate = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Annotate",
    )!;
    await userEvent.click(annotate);
    const overlay = document.querySelector<HTMLCanvasElement>(
      'canvas[aria-label="Draw on image"]',
    )!;
    await vi.waitFor(() => expect(overlay.width).toBe(160));
    await userEvent.click(overlay);
    const send = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Send annotation",
    )!;
    await userEvent.click(send);
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector('[aria-label="Image annotation editor"]')).not.toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')?.disabled,
    ).toBe(true);
    await act(() => retainThreadOverlaysForThread("env:b"));
    await screen.rerender(host("env:b"));
    expect(signal?.aborted).toBe(true);
    await act(() => openExpandedImagePreview("env:b", preview));
    await act(() => resolve(true));
    expect(dialog()?.textContent).toContain("one.png (1/2)");
    await userEvent.keyboard("{Escape}");
  });

  it("opens for its thread, steps with arrows, and closes on Escape with focus back on the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    using _overlays = { [Symbol.dispose]: () => retainThreadOverlaysForThread(null) };
    await using _screen = await render(host("env:a"));
    opener.focus();

    await act(() => openExpandedImagePreview("env:a", preview));
    expect(dialog()?.textContent).toContain("one.png (1/2)");

    await act(() => {
      dialog()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(dialog()?.textContent).toContain("two.png (2/2)");

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("ignores another thread's preview and drops its own when the thread changes", async () => {
    using _overlays = { [Symbol.dispose]: () => retainThreadOverlaysForThread(null) };
    await using screen = await render(host("env:a"));
    await act(() => openExpandedImagePreview("env:b", preview));
    expect(dialog()).toBeNull();

    await act(() => openExpandedImagePreview("env:a", preview));
    expect(dialog()).not.toBeNull();

    await act(() => retainThreadOverlaysForThread("env:b"));
    await screen.rerender(host("env:b"));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const snapShotSource: SnapShotSource = {
  kind: "snap-shot",
  capturedAt: "2026-01-01T00:00:00.000Z",
  appName: "Finder",
  windowTitle: "Downloads",
};

describe("ExpandedImageDialog", () => {
  it("Escape closes a popup opened inside the dialog before the dialog", async () => {
    const onClose = vi.fn();
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: PIXEL, name: "shot.png", source: snapShotSource }], index: 0 }}
        onClose={onClose}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "No accessibility data" }));
    await expect.element(screen.getByText("Accessibility data")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByText("Accessibility data")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Focus returns to the popup's trigger and opens its tooltip; leave it for a plain control.
    (screen.getByRole("button", { name: "Close image preview" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
