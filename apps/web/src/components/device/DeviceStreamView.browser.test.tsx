import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import "~/index.css";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render, stubGlobal } from "../../../test/render";
import { DeviceStreamView } from "./DeviceStreamView";

vi.mock("~/state/device", () => {
  const access = {
    httpBase: "https://device.test",
    wsBase: "wss://device.test",
    credentials: false,
    query: {},
  };
  return {
    useDeviceHubAccess: () => access,
    refreshDeviceHubAccess: vi.fn(),
    renewDeviceHubAccess: vi.fn(),
  };
});

vi.mock(import("./DevicePhoneViewport"), () => ({
  DevicePhoneViewport: () => <></>,
}));

function setupKeyboard() {
  const registry = AtomRegistry.make();
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  const resources = new DisposableStack();
  const image = vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(() => {});
  resources.defer(() => image.mockRestore());
  resources.use(stubGlobal("WebSocket", Socket));
  resources.use(stubGlobal("VideoDecoder", undefined));
  Reflect.deleteProperty(globalThis, "VideoDecoder");
  resources.use(
    stubGlobal(
      "fetch",
      vi.fn(async () => new Response("prime")),
    ),
  );
  resources.defer(() => registry.dispose());
  return {
    view: (deviceId = "phone") => (
      <RegistryContext.Provider value={registry}>
        <Stream deviceId={deviceId} />
      </RegistryContext.Provider>
    ),
    sockets,
    async admit(index = 0) {
      await vi.waitFor(() => expect(sockets).toHaveLength(index + 1));
      const socket = sockets[index]!;
      await act(() => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
      return socket;
    },
    messages(index = 0) {
      return sockets[index]!.send.mock.calls.map(([payload]) => {
        const bytes = payload as Uint8Array;
        expect(bytes[0]).toBe(0x06);
        return JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
      });
    },
    [Symbol.dispose]: () => resources.dispose(),
  };
}

function Stream({ deviceId = "phone" }: { deviceId?: string }) {
  return (
    <DeviceStreamView
      environmentId={EnvironmentId.make("device-key-test")}
      hostId="local"
      deviceId={deviceId}
      platform="ios"
      visible
    />
  );
}

const modifierDowns = [
  { type: "down", usage: 0xe0 },
  { type: "down", usage: 0xe1 },
];
const modifierUps = [
  { type: "up", usage: 0xe0 },
  { type: "up", usage: 0xe1 },
];

it("balances native modifier downs when the app captures Space and blurs the device", async () => {
  using fixture = setupKeyboard();
  await using screen = await render(fixture.view());
  await fixture.admit();
  const stream = screen.container.querySelector<HTMLElement>('[role="application"]')!;
  stream.focus();
  using _capture = new DisposableStack();
  const capture = (event: KeyboardEvent) => {
    if (event.code !== "Space" || !event.ctrlKey || !event.shiftKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stream.blur();
  };
  window.addEventListener("keydown", capture, true);
  _capture.defer(() => window.removeEventListener("keydown", capture, true));

  await userEvent.keyboard("{Control>}{Shift>}");
  expect(fixture.messages()).toEqual(modifierDowns);
  await userEvent.keyboard(" {/Shift}{/Control}");
  expect(document.activeElement).not.toBe(stream);
  expect(fixture.messages()).toEqual([...modifierDowns, ...modifierUps]);
  await screen.unmount();
  expect(fixture.messages()).toEqual([...modifierDowns, ...modifierUps]);
});

it("releases on window blur once even if element blur and physical keyups follow", async () => {
  using fixture = setupKeyboard();
  await using screen = await render(fixture.view());
  await fixture.admit();
  const stream = screen.container.querySelector<HTMLElement>('[role="application"]')!;
  stream.focus();
  await userEvent.keyboard("{Control>}{Shift>}");
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("blur"));
  stream.blur();
  stream.focus();
  await userEvent.keyboard("{/Shift}{/Control}");
  expect(fixture.messages()).toEqual([...modifierDowns, ...modifierUps]);
});

it("also releases when focus moves to a control inside the stream", async () => {
  using fixture = setupKeyboard();
  await using screen = await render(fixture.view());
  await fixture.admit();
  const stream = screen.container.querySelector<HTMLElement>('[role="application"]')!;
  const control = stream.appendChild(document.createElement("button"));
  stream.focus();
  await userEvent.keyboard("{Control>}{Shift>}");
  control.focus();
  await userEvent.keyboard("{/Shift}{/Control}");
  expect(fixture.messages()).toEqual([...modifierDowns, ...modifierUps]);
});

it("balances keys on client replacement and unmount without releasing them to the new device", async () => {
  using fixture = setupKeyboard();
  await using screen = await render(fixture.view());
  const first = await fixture.admit();
  screen.container.querySelector<HTMLElement>('[role="application"]')!.focus();
  await userEvent.keyboard("{Control>}{Shift>}");
  await screen.rerender(fixture.view("replacement"));
  await fixture.admit(1);
  await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
  expect(fixture.messages()).toEqual([...modifierDowns, ...modifierUps]);
  await userEvent.keyboard("{/Shift}{/Control}{Control>}{Shift>}");
  expect(fixture.messages(1)).toEqual(modifierDowns);
  await screen.unmount();
  window.dispatchEvent(new Event("blur"));
  await userEvent.keyboard("{/Shift}{/Control}");
  expect(fixture.messages(1)).toEqual([...modifierDowns, ...modifierUps]);
});

function setupPointer() {
  const registry = AtomRegistry.make();
  const touches: unknown[] = [];
  const image = vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(() => {});
  // Select MJPEG without starting a WebCodecs decoder. Input uses the real stream client.
  const decoder = stubGlobal("VideoDecoder", undefined);
  Reflect.deleteProperty(globalThis, "VideoDecoder");
  const fetch = stubGlobal("fetch", () => Promise.resolve(new Response("prime")));
  // The client opens its input socket only after the MJPEG prime resolves.
  type InputSocket = {
    onmessage?: (event: { data: ArrayBuffer }) => void;
  };
  let open!: (socket: InputSocket) => void;
  const opened = new Promise<InputSocket>((resolve) => {
    open = resolve;
  });
  const socket = stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        open(this);
      }
      onmessage?: (event: { data: ArrayBuffer }) => void;
      send(message: string | Uint8Array) {
        if (typeof message !== "string" && message[0] === 0x03) {
          touches.push(JSON.parse(new TextDecoder().decode(message.subarray(1))));
        }
      }
      close() {}
    },
  );
  return {
    view: () => (
      <RegistryContext.Provider value={registry}>
        <div style={{ width: 400, height: 800 }}>{view()}</div>
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]() {
      registry.dispose();
      image.mockRestore();
      socket[Symbol.dispose]();
      fetch[Symbol.dispose]();
      decoder[Symbol.dispose]();
    },
    touches,
    async configure(inputUnavailable = false) {
      const json = new TextEncoder().encode(
        JSON.stringify({ width: 400, height: 800, orientation: "portrait", inputUnavailable }),
      );
      const packet = new Uint8Array(1 + json.length);
      packet[0] = 0x82;
      packet.set(json, 1);
      const input = await opened;
      input.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      input.onmessage?.({ data: packet.buffer });
    },
  };
}

function view() {
  return (
    <DeviceStreamView
      hostId="local"
      environmentId={EnvironmentId.make("test")}
      deviceId="test"
      platform="ios"
      visible
      allowPhoneView={false}
      renderControls={(controls) => (
        <output>
          {controls.handle?.inputConnected ? "Input connected" : "Input disconnected"}
        </output>
      )}
    />
  );
}

// router: false because the device view renders no links and never navigates.
const options = { router: false } as const;

function flatPointer(container: HTMLElement) {
  const surface = container.querySelector("canvas")!.parentElement!.parentElement!;
  // Synthetic IDs exercise concurrent touches independently of the browser's capture state.
  surface.setPointerCapture = () => {};
  const rect = new DOMRect(0, 0, 400, 800);
  surface.getBoundingClientRect = () => rect;
  return {
    send(type: string, pointerId: number, x = 0.25, y = 0.25) {
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId,
          pointerType: "touch",
          clientX: rect.left + rect.width * x,
          clientY: rect.top + rect.height * y,
        }),
      );
    },
  };
}

it("keeps the first flat pointer active when a second finger moves and lifts", async () => {
  using input = setupPointer();
  const { configure, touches } = input;
  await using screen = await render(input.view(), options);
  await act(async () => configure());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  send("pointerdown", 2, 0.75, 0.75);
  send("pointermove", 2, 0.875, 0.875);
  send("pointerup", 2);
  send("pointercancel", 2);
  send("pointermove", 1, 0.5, 0.5);
  send("pointerup", 1, 0.75, 0.75);
  send("pointermove", 1);
  expect(touches).toEqual([
    { type: "begin", x: 0.25, y: 0.25 },
    { type: "move", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});

it("ignores a flat pointer that goes down before input connects", async () => {
  using input = setupPointer();
  const { configure, touches } = input;
  await using screen = await render(input.view(), options);
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  await act(async () => configure());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  send("pointerdown", 2, 0.5, 0.5);
  send("pointerup", 2, 0.75, 0.75);
  expect(touches).toEqual([
    { type: "begin", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});

it.each(["pointerup", "pointercancel", "lostpointercapture"])(
  "ends the owned flat pointer exactly once on %s, then accepts a new pointer",
  async (ending) => {
    using input = setupPointer();
    const { configure, touches } = input;
    await using screen = await render(input.view(), options);
    await act(async () => configure());
    await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
    const { send } = flatPointer(screen.container);
    send("pointerdown", 7);
    send("pointermove", 7, 0.5, 0.5);
    send("lostpointercapture", 8, 0, 0);
    // Capture loss reports its own point; the end must still use the last move.
    const at = ending === "lostpointercapture" ? 0 : 0.5;
    send(ending, 7, at, at);
    send("lostpointercapture", 7, 0, 0);
    send("pointerup", 7);
    send("pointermove", 7);
    send("pointerdown", 9);
    send("pointerup", 9);
    expect(touches).toEqual([
      { type: "begin", x: 0.25, y: 0.25 },
      { type: "move", x: 0.5, y: 0.5 },
      { type: "end", x: 0.5, y: 0.5 },
      { type: "begin", x: 0.25, y: 0.25 },
      { type: "end", x: 0.25, y: 0.25 },
    ]);
  },
);

it("releases flat pointer ownership when input disconnects", async () => {
  using input = setupPointer();
  await using screen = await render(input.view(), options);
  await act(() => input.configure());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  await act(() => input.configure(true));
  await expect.element(screen.getByText("Input disconnected", { exact: true })).toBeVisible();
  await act(() => input.configure());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  send("pointerdown", 2, 0.5, 0.5);
  send("pointerup", 2, 0.75, 0.75);
  expect(input.touches).toEqual([
    { type: "begin", x: 0.25, y: 0.25 },
    { type: "begin", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});
