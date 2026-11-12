import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

import { sendNativeSurfaceInput, sendPageCommand, toKeyboardInputEvents } from "./GuestInput.ts";

const makeGuest = ({
  focused,
  focusedDocument = true,
}: {
  readonly focused: boolean;
  readonly focusedDocument?: boolean;
}) => {
  const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) =>
    method === "Runtime.evaluate" && params?.expression?.endsWith("!== null")
      ? { result: { value: focusedDocument } }
      : { result: {} },
  );
  const webContents = {
    focusedFrame: focused ? {} : null,
    insertText: vi.fn(async () => {}),
    sendInputEvent: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  };
  return {
    webContents,
    sendCommand,
    send: (method: string, params: Record<string, unknown>) =>
      sendPageCommand(
        webContents as unknown as Electron.WebContents,
        { sendCommand } as unknown as Electron.Debugger,
        method,
        params,
      ),
  };
};

describe("preview guest input", () => {
  it.each(["field", "same-origin-frame", "cross-site-frame"])(
    "probes the tapped %s before focus changes without reading field values",
    async (target) => {
      const field = {
        tagName: "INPUT",
        type: "password",
        disabled: false,
        readOnly: false,
        closest: (selector: string): object | null => (selector === "label" ? null : field),
        get value() {
          throw new Error("Private values must not be read");
        },
      };
      const points: Array<[number, number]> = [];
      const frameDocument = {
        elementFromPoint: (x: number, y: number) => {
          points.push([x, y]);
          return field;
        },
      };
      const frame = {
        tagName: "IFRAME",
        contentDocument: target === "same-origin-frame" ? frameDocument : null,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
        offsetWidth: 200,
        offsetHeight: 100,
        clientLeft: 1,
        clientTop: 1,
      };
      const document = {
        activeElement: { tagName: "BUTTON" },
        elementFromPoint: (x: number, y: number) => {
          points.push([x, y]);
          return target === "field" ? field : frame;
        },
      };
      const executeJavaScript = vi.fn(async (script: string) =>
        NodeVM.runInNewContext(script, { document }),
      );
      const result = await sendNativeSurfaceInput(
        { executeJavaScript } as unknown as Electron.WebContents,
        { type: "probe", x: 30, y: 40 },
        () => {},
      );
      expect(result).toEqual({ editable: target !== "cross-site-frame" });
      expect(points).toEqual(
        target === "same-origin-frame"
          ? [
              [30, 40],
              [19, 19],
            ]
          : [[30, 40]],
      );
      expect(document.activeElement.tagName).toBe("BUTTON");
      await expect(
        sendNativeSurfaceInput(
          { executeJavaScript } as unknown as Electron.WebContents,
          { type: "probe", x: Number.NaN, y: 40 },
          () => {},
        ),
      ).rejects.toThrow("finite coordinates");
      expect(executeJavaScript).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["focus-read", "insert", "key"])(
    "rejects a lease revoked during %s without sending later private mutations",
    async (phase) => {
      let valid = true;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const executeJavaScript = vi.fn(async (script: string) => {
        if (script.includes("private-value")) throw new Error("Private script payload");
        if (phase === "focus-read") {
          started.resolve();
          await finish.promise;
        }
        return true;
      });
      const insertText = vi.fn(async () => {
        started.resolve();
        await finish.promise;
      });
      const sendInputEvent = vi.fn(() => {
        valid = false;
      });
      const current = () => {
        if (!valid) throw new Error("Lease revoked");
      };
      const pending = sendNativeSurfaceInput(
        { executeJavaScript, insertText, sendInputEvent } as unknown as Electron.WebContents,
        phase === "key"
          ? { type: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 }
          : { type: "text", text: "private-value" },
        current,
      );
      if (phase !== "key") {
        await started.promise;
        valid = false;
        finish.resolve();
      }
      await expect(pending).rejects.toThrow("Lease revoked");
      expect(
        executeJavaScript.mock.calls.every(([script]) => !script.includes("private-value")),
      ).toBe(true);
      expect(insertText).toHaveBeenCalledTimes(phase === "insert" ? 1 : 0);
      expect(sendInputEvent).toHaveBeenCalledTimes(phase === "key" ? 1 : 0);
    },
  );

  it("maps private pointer input through guest zoom and keeps clipboard operations native", async () => {
    const guest = makeGuest({ focused: false });
    const webContents = Object.assign(guest.webContents, {
      executeJavaScript: vi.fn(async () => true),
      getZoomFactor: () => 1.25,
      copy: vi.fn(),
      cut: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      focus: vi.fn(),
    });
    const send = (input: Parameters<typeof sendNativeSurfaceInput>[1]) =>
      sendNativeSurfaceInput(webContents as unknown as Electron.WebContents, input, () => {});
    await send({
      type: "mouse",
      action: "down",
      x: 100,
      y: 1200,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    });
    await send({ type: "wheel", x: 100, y: 1200, deltaX: 4, deltaY: 20, modifiers: 0 });
    expect(webContents.sendInputEvent).toHaveBeenNthCalledWith(1, {
      type: "mouseDown",
      x: 125,
      y: 1500,
      button: "left",
      clickCount: 1,
      modifiers: ["leftbuttondown"],
    });
    expect(webContents.sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: "mouseWheel",
      x: 125,
      y: 1500,
      deltaX: -5,
      deltaY: -25,
      modifiers: [],
    });
    for (const key of ["c", "x", "v", "a"])
      await send({
        type: "key",
        action: "down",
        key,
        code: `Key${key.toUpperCase()}`,
        modifiers: 2,
      });
    expect(webContents.copy).toHaveBeenCalledOnce();
    expect(webContents.cut).toHaveBeenCalledOnce();
    expect(webContents.paste).toHaveBeenCalledOnce();
    expect(webContents.selectAll).toHaveBeenCalledOnce();
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(2);
    expect(webContents.focus).not.toHaveBeenCalled();
    expect(guest.sendCommand).not.toHaveBeenCalled();
    webContents.executeJavaScript.mockResolvedValue(false);
    await expect(send({ type: "text", text: "private-value" })).rejects.toThrow(/cross-site frame/);
    expect(webContents.insertText).not.toHaveBeenCalled();
  });

  it("types into an unfocused guest's own page, not the app's focused field", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.insertText", { text: "pairing-code" });
    expect(guest.webContents.insertText).toHaveBeenCalledWith("pairing-code");
    expect(guest.sendCommand).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it.each([
    {
      sessionId: undefined,
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "restore",
    },
    {
      sessionId: "child-frame",
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "restore",
    },
    {
      sessionId: undefined,
      method: "Input.dispatchTouchEvent",
      type: "touchStart",
      outcome: "restore",
    },
    {
      sessionId: undefined,
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "other-field",
    },
    {
      sessionId: undefined,
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "removed",
    },
    {
      sessionId: undefined,
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "failure",
    },
  ])(
    "preserves host focus for $method in $sessionId with $outcome",
    async ({ sessionId, method, type, outcome }) => {
      const document = { activeElement: {} as object };
      const composer = {
        isConnected: true,
        focus: () => {
          document.activeElement = composer;
        },
      };
      const preview = { tagName: "WEBVIEW", getWebContentsId: () => 7 };
      const otherField = { tagName: "INPUT" };
      document.activeElement = composer;
      const context = NodeVM.createContext({ document });
      const host = {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => NodeVM.runInContext(script, context),
      };
      const guest = { id: 7, focusedFrame: null, hostWebContents: host };
      const debuggee = {
        sendCommand: async () => {
          document.activeElement = outcome === "other-field" ? otherField : preview;
          if (outcome === "removed") composer.isConnected = false;
          if (outcome === "failure") throw new Error("Pointer failed");
          return {};
        },
      };
      const result = sendPageCommand(
        guest as unknown as Electron.WebContents,
        debuggee as unknown as Electron.Debugger,
        method,
        { type, x: 10, y: 10, button: "left" },
        sessionId,
      );
      if (outcome === "failure") await expect(result).rejects.toThrow("Pointer failed");
      else await result;
      expect(document.activeElement).toBe(
        outcome === "other-field" ? otherField : outcome === "removed" ? preview : composer,
      );
      expect(Object.keys(context)).toEqual(["document"]);
    },
  );

  it.each([
    {
      method: "Input.dispatchMouseEvent",
      press: "mousePressed",
      release: "mouseReleased",
      failPress: false,
      revoke: false,
    },
    {
      method: "Input.dispatchTouchEvent",
      press: "touchStart",
      release: "touchEnd",
      failPress: false,
      revoke: false,
    },
    {
      method: "Input.dispatchMouseEvent",
      press: "mousePressed",
      release: "mouseReleased",
      failPress: true,
      revoke: false,
    },
    {
      method: "Input.dispatchMouseEvent",
      press: "mousePressed",
      release: "mouseReleased",
      failPress: false,
      revoke: true,
    },
  ])(
    "keeps $method releases behind presses waiting for host focus, failed press: $failPress, revoked: $revoke",
    async ({ method, press, release, failPress, revoke }) => {
      let current = true;
      const captureStarted = Promise.withResolvers<void>();
      const finishCapture = Promise.withResolvers<void>();
      const events: Array<unknown> = [];
      const guest = {
        id: 7,
        focusedFrame: null,
        hostWebContents: {
          isDestroyed: () => false,
          executeJavaScript: async () => {
            captureStarted.resolve();
            await finishCapture.promise;
          },
        },
      };
      const debuggee = {
        sendCommand: async (_method: string, params: Record<string, unknown>) => {
          events.push(params["type"]);
          if (failPress && params["type"] === press) throw new Error("Press failed");
          return {};
        },
      };
      const send = (type: string) =>
        sendPageCommand(
          guest as unknown as Electron.WebContents,
          debuggee as unknown as Electron.Debugger,
          method,
          { type },
          undefined,
          () => {
            if (!current) throw new Error("Private credential entry");
          },
        );
      const pressed = send(press);
      await captureStarted.promise;
      const released = send(release);
      if (revoke) current = false;
      finishCapture.resolve();
      const results = await Promise.allSettled([pressed, released]);
      expect(results.map((result) => result.status)).toEqual([
        failPress || revoke ? "rejected" : "fulfilled",
        revoke ? "rejected" : "fulfilled",
      ]);
      expect(events).toEqual(revoke ? [] : [press, release]);
    },
  );

  it("refuses input when a cross-site frame holds the unfocused page's focus", async () => {
    const guest = makeGuest({ focused: false, focusedDocument: false });
    await expect(guest.send("Input.insertText", { text: "secret" })).rejects.toThrow(
      /cross-site frame/,
    );
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });
});

describe("CDP key events as Electron input", () => {
  it("sends a key's text as char events after its key down", () => {
    expect(toKeyboardInputEvents({ type: "keyDown", key: "Enter", text: "\r" })).toEqual([
      { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      { type: "char", keyCode: "\r", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "keyDown", key: "é", text: "é", modifiers: 8 })).toEqual([
      { type: "rawKeyDown", keyCode: "é", modifiers: ["shift"] },
      { type: "char", keyCode: "é", modifiers: ["shift"] },
    ]);
  });

  // regression: #18556 agent typing in a preview tab landed in the app instead of the guest
  it("names arrows and function keys as Electron accelerators", () => {
    expect(toKeyboardInputEvents({ type: "keyUp", key: "ArrowLeft", modifiers: 3 })).toEqual([
      { type: "keyUp", keyCode: "Left", modifiers: ["alt", "control"] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "F12" })).toEqual([
      { type: "rawKeyDown", keyCode: "F12", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "AudioVolumeUp" })).toEqual([]);
  });
});
