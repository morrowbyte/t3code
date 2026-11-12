import { EnvironmentId } from "@t3tools/contracts";
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

import { ServerBrowserSurface } from "./ServerBrowserSurface";

function setup() {
  mocks.sent.length = 0;
  mocks.painted = null;
  mocks.stopClient.mockReset();
  mocks.createClient.mockReset().mockImplementation(() => ({
    send: (input: PreviewStreamInput) => {
      mocks.sent.push(input);
      return true;
    },
    stop: mocks.stopClient,
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
  mocks.sent.length = 0;
  const input = container.querySelector("textarea")!;
  const canvas = container.querySelector("canvas")!;
  stack.move();
  return { screen, input, canvas };
}

const keys = () => mocks.sent.filter((input) => input.type === "key");

describe("ServerBrowserSurface native controls", () => {
  it("waits for confirmed takeover and release, fences reconnects, and disconnects when hidden", async () => {
    setup();
    const onControl = vi.fn();
    const surface = (visible: boolean) => (
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("environment-native")}
        threadId="thread-native"
        tabId="tab-native"
        mode="native"
        visible={visible}
        onControl={onControl}
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
    expect(container.querySelector("[data-native-page]")).not.toBeNull();
    const nativePage = container.querySelector("[data-native-page]")!;
    expect(nativePage.getAttribute("data-interactive")).toBe("false");
    expect(container.querySelector("canvas, textarea")).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();

    const handlers = mocks.createClient.mock.calls.at(-1)![1];
    const control = (
      controller: PreviewStreamControl["controller"],
      canOperate = true,
      ready = true,
    ) => handlers.onControl?.({ controller, canOperate, ready, generation: 1, dialog: null });
    await act(() => control("agent"));
    await userEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(mocks.sent).toEqual([{ type: "takeControl" }]);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Agent has control");
    await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();

    await act(() => control("you", true, false));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Control reserved…");
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeDisabled();
    expect(nativePage.getAttribute("data-interactive")).toBe("false");
    await act(() => control("you"));
    await expect.element(screen.getByRole("status")).toHaveTextContent("You have control");
    expect(nativePage.getAttribute("data-interactive")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Release control" }));
    expect(mocks.sent).toEqual([{ type: "takeControl" }, { type: "releaseControl" }]);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Releasing control…");
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeDisabled();
    expect(nativePage.getAttribute("data-interactive")).toBe("false");
    await act(() => control("agent"));

    await act(() => handlers.onConnectedChange(false));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();
    expect(onControl).toHaveBeenLastCalledWith(null);
    expect(nativePage.getAttribute("data-interactive")).toBe("false");
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
    expect(nativePage.getAttribute("data-interactive")).toBe("false");

    await act(() => control("you"));
    mocks.sent.length = 0;
    await screen.rerender(surface(false));
    expect(mocks.stopClient).toHaveBeenCalledOnce();
    expect(onControl).toHaveBeenLastCalledWith(null);
    expect(mocks.sent).toEqual([]);
  });
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
