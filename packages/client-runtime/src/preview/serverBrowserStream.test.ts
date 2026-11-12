import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPreviewStreamClient, type PreviewStreamControl } from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("inspects only under viewer ownership and validates comment-free selection replies", () => {
    const onSelection = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
      onSelection,
    });
    const socket = FakeSocket.current;
    const inspect = { type: "inspect", requestId: "pick-1", x: 20, y: 30 } as const;
    socket.control(agent);
    expect(client.send(inspect)).toBe(false);
    socket.control({ ...agent, controller: "you", generation: 2 });
    expect(client.send(inspect)).toBe(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual(inspect);
    const annotation = {
      id: "pick-1",
      pageUrl: "http://app.test",
      pageTitle: null,
      comment: "",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "now",
    };
    socket.message(JSON.stringify({ type: "selection", requestId: "pick-1", annotation }));
    expect(onSelection).toHaveBeenCalledWith("pick-1", annotation, false);
    socket.message(
      JSON.stringify({ type: "selection", requestId: "invalid", annotation: { comment: "" } }),
    );
    expect(onSelection).toHaveBeenCalledTimes(1);
    socket.message(JSON.stringify({ type: "selection", requestId: "clear", annotation: null }));
    expect(onSelection).toHaveBeenLastCalledWith("clear", null, false);
    socket.message(
      JSON.stringify({ type: "selection", requestId: "failure", annotation: null, failed: true }),
    );
    expect(onSelection).toHaveBeenLastCalledWith("failure", null, true);
    socket.control({ ...agent, controller: "another-viewer", generation: 3 });
    expect(client.send(inspect)).toBe(false);
    client.stop();
  });

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });

  it.each([
    "control-only",
    "wrong-request",
    "stale-generation",
    "close",
    "stop",
    "abort",
    "success",
    "controller-change",
    "generation-change",
    "release-refused",
    "wrong-completion-generation",
  ])(
    "correlates native preparation to one drained release and live socket (%s)",
    async (outcome) => {
      vi.useFakeTimers();
      const client = createPreviewStreamClient(
        { ...target, frames: false },
        {
          onFrame: vi.fn(),
          onViewport: vi.fn(),
          onConnectedChange: vi.fn(),
          onUnauthorized: vi.fn(),
        },
      );
      try {
        const socket = FakeSocket.current;
        socket.dispatchEvent(new Event("open"));
        socket.control({ ...agent, controller: "you", generation: 4, ready: true });
        const abort = new AbortController();
        const pending = client.preparePrivateEntry(4, abort.signal);
        const assertion =
          outcome === "success"
            ? expect(pending).resolves.toBeUndefined()
            : expect(pending).rejects.toThrow();
        const request = JSON.parse(socket.sent.at(-1)!);
        expect(request).toEqual({
          type: "releaseControl",
          requestId: expect.any(String),
          expectedGeneration: 4,
          preparePrivateEntry: true,
        });
        expect(client.send({ type: "text", text: "late input" })).toBe(false);
        socket.control({ ...agent, controller: "unclaimed", generation: 5, ready: false });
        const receipt = {
          type: "controlReleased",
          requestId: request.requestId,
          expectedGeneration: 4,
          generation: 5,
          released: true,
        };
        if (outcome === "success") socket.message(JSON.stringify(receipt));
        else if (outcome === "close") {
          socket.dispatchEvent(new CloseEvent("close", { code: 1012 }));
          await vi.advanceTimersByTimeAsync(500);
          const replacement = FakeSocket.current;
          expect(replacement).not.toBe(socket);
          socket.message(JSON.stringify(receipt));
          expect(replacement.sent).toEqual([]);
        } else if (outcome === "stop") client.stop();
        else if (outcome === "controller-change" || outcome === "generation-change") {
          socket.control({
            ...agent,
            controller: outcome === "controller-change" ? "another-viewer" : "unclaimed",
            generation: outcome === "generation-change" ? 6 : 5,
            ready: false,
          });
          socket.control({ ...agent, controller: "unclaimed", generation: 5, ready: false });
          socket.message(JSON.stringify(receipt));
        } else if (outcome === "release-refused") {
          socket.message(JSON.stringify({ ...receipt, released: false }));
          socket.message(JSON.stringify(receipt));
        } else if (outcome === "wrong-completion-generation") {
          socket.message(JSON.stringify({ ...receipt, generation: 6 }));
          socket.message(JSON.stringify(receipt));
        } else {
          if (outcome === "wrong-request")
            socket.message(JSON.stringify({ ...receipt, requestId: "another-operation" }));
          if (outcome === "stale-generation")
            socket.message(JSON.stringify({ ...receipt, expectedGeneration: 3 }));
          abort.abort();
        }
        await assertion;
        expect(client.send({ type: "text", text: "unclaimed input" })).toBe(false);
      } finally {
        client.stop();
        vi.useRealTimers();
      }
    },
  );
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});
