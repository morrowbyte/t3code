import {
  EnvironmentId,
  type DesktopPreviewBridge,
  type DesktopPreviewSurfaceFrame,
  type DesktopPreviewSurfaceFocusRequest,
} from "@t3tools/contracts";
import { createRef } from "react";
import type {
  PreviewStreamControl,
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn<(target: unknown, handlers: PreviewStreamEvents) => unknown>(),
  sent: [] as PreviewStreamInput[],
  access: { url: "ws://preview.test", token: "test" },
  painted: null as (() => void) | null,
  stopClient: vi.fn(),
  preparePrivateEntry: vi.fn<(generation: number, signal: AbortSignal) => Promise<void>>(),
  present: vi.fn<DesktopPreviewBridge["surface"]["present"]>(),
  ack: vi.fn<DesktopPreviewBridge["surface"]["ack"]>(),
  focus: vi.fn<DesktopPreviewBridge["surface"]["focus"]>(),
  input: vi.fn<DesktopPreviewBridge["surface"]["input"]>(),
  frameListeners: new Set<(frame: DesktopPreviewSurfaceFrame) => void>(),
  focusListeners: new Set<(request: DesktopPreviewSurfaceFocusRequest) => void>(),
}));

vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewStreamClient: mocks.createClient as never,
  createPreviewFramePainter: (_canvas, onPainted) => {
    mocks.painted = onPainted ?? null;
    return { paint: () => undefined, stop: () => undefined };
  },
}));

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => mocks.access as never,
}));

vi.mock(import("~/components/preview/previewBridge"), () => ({
  previewBridge: {
    surface: {
      present: mocks.present,
      ack: mocks.ack,
      focus: mocks.focus,
      onFocusRequest: (listener: (request: DesktopPreviewSurfaceFocusRequest) => void) => {
        mocks.focusListeners.add(listener);
        return () => {
          mocks.focusListeners.delete(listener);
        };
      },
      input: mocks.input,
      onFrame: (listener: (frame: DesktopPreviewSurfaceFrame) => void) => {
        mocks.frameListeners.add(listener);
        return () => {
          mocks.frameListeners.delete(listener);
        };
      },
    },
  } as never,
}));

import { ServerBrowserSurface, type ServerBrowserHandle } from "./ServerBrowserSurface";
import {
  acquireDesktopBrowserHostState,
  createLocalBrowserFrameReceiver,
} from "./desktopBrowserSurface";

function setup() {
  mocks.sent.length = 0;
  mocks.painted = null;
  mocks.stopClient.mockReset();
  mocks.preparePrivateEntry.mockReset().mockResolvedValue(undefined);
  mocks.frameListeners.clear();
  mocks.focusListeners.clear();
  mocks.present
    .mockReset()
    .mockResolvedValue({ kind: "offscreen", webContentsId: 8, privateEntry: false });
  mocks.ack.mockReset().mockResolvedValue(undefined);
  mocks.focus.mockReset().mockResolvedValue(undefined);
  mocks.input.mockReset().mockResolvedValue({});
  mocks.createClient.mockReset().mockImplementation(() => ({
    send: (input: PreviewStreamInput) => {
      mocks.sent.push(input);
      return true;
    },
    stop: mocks.stopClient,
    preparePrivateEntry: mocks.preparePrivateEntry,
  }));
}

async function renderSurface(controller: PreviewStreamControl["controller"]) {
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 300px; display: flex;";
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("environment-copy")}
        threadId="thread-copy"
        tabId="tab-copy"
        visible
        followSize={false}
        className="flex-1"
      />,
      { container },
    ),
  );
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
  const handlers = mocks.createClient.mock.calls.at(-1)![1];
  await act(() =>
    handlers.onControl?.({ canOperate: true, controller, generation: 1, dialog: null }),
  );
  expect(mocks.createClient).toHaveBeenCalledTimes(1);
  expect(mocks.stopClient).not.toHaveBeenCalled();
  if (controller === "you")
    await expect.element(screen.getByRole("textbox", { name: "Browser page" })).toBeEnabled();
  else await expect.element(screen.getByRole("textbox", { name: "Browser page" })).toBeDisabled();
  mocks.sent.length = 0;
  const input = container.querySelector("textarea")!;
  const canvas = container.querySelector("canvas")!;
  stack.move();
  return { screen, input, canvas };
}

const keys = () => mocks.sent.filter((input) => input.type === "key");

async function canvasPng(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((value) => resolve(value!), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

describe("ServerBrowserSurface native controls", () => {
  it.each([false, true])(
    "waits for confirmed takeover and release, fences reconnects, and disconnects when hidden (offscreen=%s)",
    async (offscreen) => {
      setup();
      const host = acquireDesktopBrowserHostState("runtime-native");
      using _host = { [Symbol.dispose]: host.release };
      if (offscreen) host.update({ kind: "offscreen", webContentsId: 8, privateEntry: false });
      const onControl = vi.fn();
      const onFirstFrame = vi.fn();
      const surface = (visible: boolean) => (
        <ServerBrowserSurface
          environmentId={EnvironmentId.make("environment-native")}
          threadId="thread-native"
          tabId="tab-native"
          runtimeTabId="runtime-native"
          mode="native"
          visible={visible}
          onControl={onControl}
          onFirstFrame={onFirstFrame}
        >
          {(interactive) => <div data-native-page data-interactive={interactive} />}
        </ServerBrowserSurface>
      );
      const container = document.createElement("div");
      await using screen = await render(surface(true), { container });
      await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
      expect(mocks.createClient.mock.calls.at(-1)![0]).toMatchObject({
        threadId: "thread-native",
        tabId: "tab-native",
        frames: false,
      });
      const nativePage = container.querySelector("[data-native-page]");
      const interactive = () =>
        offscreen
          ? !container.querySelector("textarea")!.disabled
          : nativePage?.getAttribute("data-interactive") === "true";
      expect(interactive()).toBe(false);
      expect(Boolean(container.querySelector("canvas, textarea"))).toBe(offscreen);
      expect(Boolean(nativePage)).toBe(!offscreen);
      if (offscreen) {
        const canvas = container.querySelector("canvas")!;
        const png = await canvasPng(canvas);
        const surfaceId = mocks.present.mock.calls.find(([value]) => value.visible)![0].surfaceId;
        await act(() => {
          for (const listener of mocks.frameListeners)
            listener({
              tabId: "runtime-native",
              surfaceId,
              webContentsId: 8,
              sequence: 1,
              generation: 1,
              width: 300,
              height: 150,
              privateEntry: false,
              png,
            });
        });
        await vi.waitFor(() => expect(mocks.ack).toHaveBeenCalled());
        await vi.waitFor(() => expect(onFirstFrame).toHaveBeenCalledOnce());
      }
      await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();

      const handlers = mocks.createClient.mock.calls.at(-1)![1];
      const control = (
        controller: PreviewStreamControl["controller"],
        canOperate = true,
        ready = true,
      ) => handlers.onControl?.({ controller, canOperate, ready, generation: 1, dialog: null });
      await act(() => control("agent"));
      expect(mocks.createClient).toHaveBeenCalledTimes(1);
      expect(mocks.stopClient).not.toHaveBeenCalled();
      await expect.element(screen.getByRole("button", { name: "Take control" })).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: "Take control" }));
      expect(mocks.sent).toEqual([{ type: "takeControl" }]);
      await expect.element(screen.getByRole("status")).toHaveTextContent("Agent has control");
      await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();

      await act(() => control("you", true, false));
      await expect.element(screen.getByRole("status")).toHaveTextContent("Control reserved…");
      await expect.element(screen.getByRole("button", { name: "Release control" })).toBeDisabled();
      expect(interactive()).toBe(false);
      await act(() => control("you"));
      await expect.element(screen.getByRole("status")).toHaveTextContent("You have control");
      expect(interactive()).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Release control" }));
      expect(mocks.sent).toEqual([{ type: "takeControl" }, { type: "releaseControl" }]);
      await expect.element(screen.getByRole("status")).toHaveTextContent("Releasing control…");
      await expect.element(screen.getByRole("button", { name: "Release control" })).toBeDisabled();
      expect(interactive()).toBe(false);
      await act(() => control("agent"));

      await act(() => handlers.onConnectedChange(false));
      await expect.element(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
      await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();
      expect(onControl).toHaveBeenLastCalledWith(null);
      expect(interactive()).toBe(false);
      await act(() => handlers.onConnectedChange(true));
      await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();
      expect(mocks.sent).toHaveLength(2);

      await act(() => control("another-viewer"));
      await expect
        .element(screen.getByRole("status"))
        .toHaveTextContent("Another viewer has control");
      await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();
      await act(() => control("unclaimed", false));
      await expect.element(screen.getByRole("status")).toHaveTextContent("Read-only");
      await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();

      await act(() =>
        handlers.onControl?.({ controller: "you", canOperate: true, generation: 1, dialog: null }),
      );
      await expect
        .element(screen.getByRole("status"))
        .toHaveTextContent("Update the server to use native control.");
      await expect.element(screen.getByRole("button", { name: "Release control" })).toBeDisabled();
      expect(interactive()).toBe(false);

      await act(() => control("you"));
      mocks.sent.length = 0;
      await act(() => handlers.onGone?.());
      await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
      await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalledTimes(2));
      if (!offscreen) expect(container.querySelector("[data-native-page]")).toBe(nativePage);
      expect(mocks.sent).toEqual([]);
      await screen.rerender(surface(false));
      expect(mocks.stopClient).toHaveBeenCalledTimes(2);
      expect(onControl).toHaveBeenLastCalledWith(null);
      expect(mocks.sent).toEqual([]);
    },
  );

  it("keeps private pixels local, uses the displayed frame for private input, and clears on detach", async () => {
    setup();
    const host = acquireDesktopBrowserHostState("runtime-private");
    using _host = { [Symbol.dispose]: host.release };
    host.update({ kind: "offscreen", webContentsId: 8, privateEntry: false });
    const handle = createRef<ServerBrowserHandle>();
    const onSelection = vi.fn();
    const container = document.createElement("div");
    container.style.cssText = "width: 400px; height: 300px; display: flex;";
    await using screen = await render(
      <ServerBrowserSurface
        ref={handle}
        environmentId={EnvironmentId.make("environment-private")}
        threadId="thread-private"
        tabId="tab-private"
        runtimeTabId="runtime-private"
        mode="native"
        visible
        picking
        onSelection={onSelection}
        className="flex-1"
      />,
      { container },
    );
    await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
    expect(mocks.createClient.mock.calls.at(-1)![0]).toMatchObject({ frames: false });
    const handlers = mocks.createClient.mock.calls.at(-1)![1];
    const canvas = container.querySelector("canvas")!;
    const input = container.querySelector("textarea")!;
    using _documentFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const seed = document.createElement("canvas");
    seed.width = 800;
    seed.height = 600;
    const png = await canvasPng(seed);
    const surfaceId = mocks.present.mock.calls.find(([value]) => value.visible)![0].surfaceId;
    const frame = (
      sequence: number,
      generation: number,
      privateEntry: boolean,
      webContentsId = 8,
    ): DesktopPreviewSurfaceFrame => ({
      tabId: "runtime-private",
      surfaceId,
      webContentsId,
      sequence,
      generation,
      width: 400,
      height: 300,
      privateEntry,
      png,
    });
    const emitFrame = async (value: DesktopPreviewSurfaceFrame) => {
      await act(() => {
        for (const listener of mocks.frameListeners) listener(value);
      });
      await vi.waitFor(() =>
        expect(mocks.ack).toHaveBeenCalledWith({
          tabId: value.tabId,
          surfaceId,
          webContentsId: value.webContentsId,
          sequence: value.sequence,
          generation: value.generation,
        }),
      );
    };
    await emitFrame(frame(1, 1, false));
    await vi.waitFor(() =>
      expect(handle.current?.screenshot()?.cropRect).toEqual({
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      }),
    );
    expect(handle.current?.screenshot()?.width).toBe(800);
    await act(() =>
      handlers.onControl?.({
        controller: "you",
        canOperate: true,
        ready: false,
        generation: 1,
        dialog: null,
      }),
    );
    expect(input.disabled).toBe(true);
    await act(() =>
      handlers.onControl?.({
        controller: "you",
        canOperate: true,
        ready: true,
        generation: 1,
        dialog: null,
      }),
    );
    await expect.element(screen.getByRole("textbox", { name: "Browser page" })).toBeEnabled();
    const enterText = async (text: string) =>
      act(() => {
        input.value = `\u200b${text}`;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      });
    await enterText("public input");
    expect(mocks.sent).toContainEqual({ type: "text", text: "public input" });
    expect(mocks.input).not.toHaveBeenCalled();
    const requestFocus = async (
      requestId: string,
      override: Partial<DesktopPreviewSurfaceFocusRequest> = {},
    ) => {
      const request = {
        tabId: "runtime-private",
        surfaceId,
        webContentsId: 8,
        sequence: 1,
        generation: 1,
        requestId,
        ...override,
      };
      await act(() => {
        for (const listener of mocks.focusListeners) listener(request);
      });
    };
    await requestFocus("menu-focus");
    expect(mocks.preparePrivateEntry).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(mocks.focus).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "menu-focus", focused: true }),
    );
    await requestFocus("stale-focus", { sequence: 0 });
    expect(mocks.focus).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "stale-focus", focused: false }),
    );
    const focusCalls = mocks.focus.mock.calls.length;
    await requestFocus("wrong-contents", { webContentsId: 99 });
    expect(mocks.focus).toHaveBeenCalledTimes(focusCalls);
    _documentFocus.mockReturnValue(false);
    await requestFocus("unfocused-document");
    expect(mocks.focus).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "unfocused-document", focused: false }),
    );
    _documentFocus.mockReturnValue(true);
    await act(() => input.blur());
    expect(mocks.focus.mock.calls.at(-1)?.[0].focused).toBe(false);
    await requestFocus("returned-focus");
    mocks.sent.length = 0;

    let releaseViewer!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseViewer = resolve;
    });
    mocks.preparePrivateEntry.mockReturnValueOnce(released);
    const clientsBeforePreparation = mocks.createClient.mock.calls.length;
    const stopsBeforePreparation = mocks.stopClient.mock.calls.length;
    await requestFocus("prepare-entry", { preparation: "begin" });
    expect(mocks.preparePrivateEntry).toHaveBeenCalledExactlyOnceWith(1, expect.any(AbortSignal));
    expect(mocks.createClient).toHaveBeenCalledTimes(clientsBeforePreparation);
    expect(mocks.stopClient).toHaveBeenCalledTimes(stopsBeforePreparation);
    expect(mocks.preparePrivateEntry.mock.calls[0]![1].aborted).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    await enterText("must not enter before the native grant");
    expect(mocks.sent).toEqual([]);
    expect(mocks.input).not.toHaveBeenCalled();
    await act(() =>
      handlers.onControl?.({
        controller: "unclaimed",
        canOperate: true,
        ready: false,
        generation: 2,
        dialog: null,
      }),
    );
    expect(document.activeElement).toBe(input);
    expect(mocks.focus).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "prepare-entry", prepared: true }),
    );
    releaseViewer();
    await vi.waitFor(() =>
      expect(mocks.focus).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "prepare-entry", prepared: true, focused: false }),
      ),
    );
    await requestFocus("focus-after-drain");
    expect(mocks.focus).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "focus-after-drain", focused: true }),
    );
    await act(() =>
      handlers.onControl?.({
        controller: "another-viewer",
        canOperate: true,
        ready: false,
        generation: 3,
        dialog: null,
      }),
    );
    expect(document.activeElement).toBe(input);
    await requestFocus("prepare-entry", { preparation: "finish", privateEntry: true });
    expect(input.readOnly).toBe(true);

    await emitFrame(frame(2, 2, true));
    await vi.waitFor(() =>
      expect(mocks.focus).toHaveBeenCalledWith(
        expect.objectContaining({ surfaceId, webContentsId: 8, sequence: 2, generation: 2 }),
      ),
    );
    expect(document.activeElement).toBe(input);
    await vi.waitFor(() => expect(input.readOnly).toBe(false));
    expect(handle.current?.canvas()).toBeNull();
    expect(handle.current?.screenshot()).toBeNull();
    expect(onSelection).toHaveBeenCalledWith(null);
    await emitFrame(frame(3, 1, false));
    await emitFrame(frame(4, 2, false, 9));
    expect(handle.current?.screenshot()).toBeNull();
    await act(() => handlers.onConnectedChange(false));
    expect(input.disabled).toBe(false);
    await enterText("local input");
    expect(mocks.input).toHaveBeenLastCalledWith({
      tabId: "runtime-private",
      surfaceId,
      webContentsId: 8,
      sequence: 2,
      generation: 2,
      input: { type: "text", text: "local input" },
    });
    expect(mocks.sent).toEqual([]);
    mocks.input.mockResolvedValue({ editable: true });
    const box = canvas.getBoundingClientRect();
    const touch = (type: "pointerdown" | "pointerup") =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerType: "touch",
          pointerId: 1,
          isPrimary: true,
          button: 0,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          bubbles: true,
        }),
      );
    await act(() => {
      touch("pointerdown");
    });
    expect(mocks.input).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sequence: 2,
        generation: 2,
        input: { type: "probe", x: expect.closeTo(200), y: expect.closeTo(150) },
      }),
    );
    await act(() => {
      touch("pointerup");
    });
    expect(document.activeElement).toBe(input);
    expect(mocks.sent).toEqual([]);
    mocks.input.mockClear();
    mocks.input.mockRejectedValueOnce(new Error("expired private lease"));
    await enterText("refused input");
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Private input was refused. Take control again.");
    expect(mocks.input).toHaveBeenCalledTimes(1);
    expect(mocks.sent).toEqual([]);

    await act(() => host.update({ kind: "pending", webContentsId: null, privateEntry: false }));
    expect(handle.current?.screenshot()).toBeNull();
    expect(canvas.width).toBe(0);
    expect(mocks.frameListeners.size).toBe(0);
    expect(mocks.focusListeners.size).toBe(0);
    expect(mocks.focus.mock.calls.at(-1)?.[0].focused).toBe(false);
    expect(mocks.present).toHaveBeenCalledWith({
      tabId: "runtime-private",
      surfaceId,
      visible: false,
    });
  });

  it.each([false, true])(
    "discards an older local decode and acknowledges both frames (stopped=%s)",
    async (stopped) => {
      setup();
      const canvas = document.createElement("canvas");
      const png = await canvasPng(canvas);
      const bitmap = await createImageBitmap(canvas);
      let finishDecode: ((value: ImageBitmap) => void) | undefined;
      using _decode = vi.spyOn(globalThis, "createImageBitmap").mockImplementationOnce(
        () =>
          new Promise<ImageBitmap>((resolve) => {
            finishDecode = resolve;
          }),
      );
      using closed = vi.spyOn(bitmap, "close");
      let markAckStarted: (() => void) | undefined;
      let releaseAck: (() => void) | undefined;
      const ackStarted = new Promise<void>((resolve) => {
        markAckStarted = resolve;
      });
      const ackPending = new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      mocks.ack.mockImplementation((frame) => {
        if (frame.sequence !== 2) return Promise.resolve();
        markAckStarted?.();
        return ackPending;
      });
      const onPainted = vi.fn();
      const onError = vi.fn();
      const receiver = createLocalBrowserFrameReceiver({
        canvas,
        bridge: {
          present: mocks.present,
          ack: mocks.ack,
          focus: mocks.focus,
          onFocusRequest: () => () => undefined,
          input: mocks.input,
          onFrame: () => () => undefined,
        },
        tabId: "runtime-decode",
        surfaceId: "surface-decode",
        webContentsId: 8,
        onPrivateEntry: vi.fn(),
        onPainted,
        onError,
      });
      using _receiver = { [Symbol.dispose]: receiver.stop };
      const first: DesktopPreviewSurfaceFrame = {
        tabId: "runtime-decode",
        surfaceId: "surface-decode",
        webContentsId: 8,
        sequence: 1,
        generation: 1,
        width: 300,
        height: 150,
        privateEntry: false,
        png,
      };
      const decoding = receiver.receive(first);
      await receiver.receive({ ...first, sequence: 2, generation: 2 });
      expect(mocks.ack).not.toHaveBeenCalled();
      if (stopped) receiver.stop();
      finishDecode?.(bitmap);
      await ackStarted;
      expect(onPainted).not.toHaveBeenCalled();
      releaseAck?.();
      await decoding;
      if (stopped) expect(onPainted).not.toHaveBeenCalled();
      else
        expect(onPainted).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sequence: 2, generation: 2 }),
        );
      expect(onError).not.toHaveBeenCalled();
      expect(closed).toHaveBeenCalledOnce();
      expect(mocks.ack).toHaveBeenCalledWith(
        expect.objectContaining({ sequence: 1, generation: 1 }),
      );
      expect(mocks.ack).toHaveBeenCalledWith(
        expect.objectContaining({ sequence: 2, generation: 2 }),
      );
    },
  );
});

describe("ServerBrowserSurface clipboard commands", () => {
  it("sends a native Copy or Cut menu command to the page once", async () => {
    setup();
    const { screen, input, canvas } = await renderSurface("you");
    await using _screen = screen;
    // Chromium runs a script Copy or Cut only during a user gesture, as a menu click is.
    await userEvent.click(canvas);
    input.focus();
    mocks.sent.length = 0;

    // Like Electron's webContents.copy(): the browser's Copy command, with no key.
    expect(document.execCommand("copy")).toBe(true);
    expect(keys()).toEqual([
      { type: "key", action: "down", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
      { type: "key", action: "up", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
    ]);

    mocks.sent.length = 0;
    expect(document.execCommand("cut")).toBe(true);
    expect(input.value).toBe("\u200b");
    expect(keys()).toEqual([
      { type: "key", action: "down", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 },
      { type: "key", action: "up", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 },
    ]);
  });

  it("sends a keyboard Copy or Cut once and leaves menu Copy working after any shortcut", async () => {
    setup();
    const { screen, input, canvas } = await renderSurface("you");
    await using _screen = screen;
    await userEvent.click(canvas);
    input.focus();
    const prevented: boolean[] = [];
    const onKeyDown = (event: KeyboardEvent) => {
      if (/^[cx]$/i.test(event.key)) prevented.push(event.defaultPrevented);
    };
    window.addEventListener("keydown", onKeyDown);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("keydown", onKeyDown) };

    // An unprevented copy or cut key also makes the browser fire copy or cut: here Chromium's
    // Ctrl key binding, on macOS Electron's menu after the Meta keyup.
    for (const [shortcut, cancels] of [
      ["{Control>}x{/Control}", true],
      ["{Control>}c{/Control}", true],
      ["{Meta>}{x>}{/Meta}{/x}", true],
      ["{Control>}{Shift>}c{/Shift}{/Control}", false],
      ["{Control>}{Alt>}x{/Alt}{/Control}", false],
    ] as const) {
      mocks.sent.length = 0;
      prevented.length = 0;
      await userEvent.keyboard(shortcut);
      expect(prevented, shortcut).toEqual([cancels]);
      expect(keys().filter((key) => /^[cx]$/i.test(key.key)).length, shortcut).toBe(2);
      expect(input.value).toBe("\u200b");

      mocks.sent.length = 0;
      expect(document.execCommand("copy")).toBe(true);
      expect(keys(), shortcut).toEqual([
        { type: "key", action: "down", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
        { type: "key", action: "up", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
      ]);
    }
  });

  it("sends nothing when another viewer controls the page", async () => {
    setup();
    const { screen, input } = await renderSurface("another-viewer");
    await using _screen = screen;

    expect(
      input.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(
      input.dispatchEvent(new ClipboardEvent("cut", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(mocks.sent).toEqual([]);
  });
});

const mouseUp = (canvas: HTMLCanvasElement, button: number) => {
  const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  canvas.dispatchEvent(event);
  return event;
};

describe("ServerBrowserSurface history", () => {
  it("routes mouse thumb buttons to the preview's history instead of the app", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;

    expect(mouseUp(canvas, 3).defaultPrevented).toBe(true);
    expect(mouseUp(canvas, 4).defaultPrevented).toBe(true);
    expect(mocks.sent).toEqual([
      { type: "history", delta: -1 },
      { type: "history", delta: 1 },
    ]);
  });

  it("leaves other mouse buttons alone", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;

    expect(mouseUp(canvas, 0).defaultPrevented).toBe(false);
    expect(mocks.sent).toEqual([]);
  });

  it("does not forward thumb-button presses to the page", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;
    canvas.width = 400;
    canvas.height = 300;
    // Synthetic pointers have no active pointer id to capture.
    canvas.setPointerCapture = () => undefined;
    const handlers = mocks.createClient.mock.calls.at(-1)![1];
    await act(() => {
      mocks.painted?.();
      handlers.onViewport({ width: 400, height: 300 });
    });
    const { left, top } = canvas.getBoundingClientRect();
    const press = (type: "pointerdown" | "pointerup", button: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          button,
          buttons: type === "pointerdown" ? 1 << button : 0,
          clientX: left + 10,
          clientY: top + 10,
          pointerType: "mouse",
          bubbles: true,
        }),
      );
    const mouseInputs = () => mocks.sent.filter((input) => input.type === "mouse");

    for (const button of [3, 4]) {
      press("pointerdown", button);
      press("pointerup", button);
    }
    expect(mouseInputs()).toEqual([]);

    press("pointerdown", 0);
    expect(mouseInputs()).not.toEqual([]);
  });
});
