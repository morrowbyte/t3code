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

function setup() {
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
  resources.use(stubGlobal("WebSocket", Socket));
  resources.use(stubGlobal("VideoDecoder", undefined));
  resources.use(
    stubGlobal(
      "fetch",
      vi.fn(async () => new Response("prime")),
    ),
  );
  return {
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
  using fixture = setup();
  await using screen = await render(<Stream />);
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
  using fixture = setup();
  await using screen = await render(<Stream />);
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
  using fixture = setup();
  await using screen = await render(<Stream />);
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
  using fixture = setup();
  await using screen = await render(<Stream />);
  const first = await fixture.admit();
  screen.container.querySelector<HTMLElement>('[role="application"]')!.focus();
  await userEvent.keyboard("{Control>}{Shift>}");
  await screen.rerender(<Stream deviceId="replacement" />);
  await fixture.admit(1);
  expect(first.close).toHaveBeenCalledOnce();
  expect(fixture.messages()).toEqual([...modifierDowns, ...modifierUps]);
  await userEvent.keyboard("{/Shift}{/Control}{Control>}{Shift>}");
  expect(fixture.messages(1)).toEqual(modifierDowns);
  await screen.unmount();
  window.dispatchEvent(new Event("blur"));
  await userEvent.keyboard("{/Shift}{/Control}");
  expect(fixture.messages(1)).toEqual([...modifierDowns, ...modifierUps]);
});
