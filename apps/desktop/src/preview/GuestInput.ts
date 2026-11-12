// CDP input follows shared window focus; send directly to unfocused guests to avoid typing into the app.
import type {
  DesktopPreviewSurfaceInput,
  DesktopPreviewSurfaceInputResult,
} from "@t3tools/contracts";

const FOCUS_ROUTED_INPUT = new Set([
  "Input.insertText",
  "Input.dispatchKeyEvent",
  "Input.imeSetComposition",
]);

/** Direct input reaches only the main-frame process; insertText crashes when a cross-site frame has focus. */
const FOCUSED_DOCUMENT = `(() => {
  let doc = document;
  for (;;) {
    const active = doc.activeElement;
    if (active?.tagName !== "IFRAME" && active?.tagName !== "FRAME") return doc;
    if (!active.contentDocument) return null;
    doc = active.contentDocument;
  }
})()`;

/** Electron runs editing commands only for CDP keys; exclude clipboard commands to preserve the user's clipboard. */
const EDITING_COMMANDS = new Set(["selectAll", "undo", "redo"]);

const CROSS_SITE_FOCUS_MESSAGE =
  "The page's focus is inside a cross-site frame, which takes typed input only while the preview has focus. Click the field first.";

const EDITABLE_AT_POINT = `(x, y) => {
  let doc = document;
  for (;;) {
    let element = doc.elementFromPoint(x, y);
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    if (!element) return false;
    if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
      const next = element.contentDocument;
      if (!next) return false;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      x = (x - rect.left) * element.offsetWidth / rect.width - element.clientLeft;
      y = (y - rect.top) * element.offsetHeight / rect.height - element.clientTop;
      doc = next;
      continue;
    }
    const label = element.closest("label");
    if (label?.control) element = label.control;
    if (element.isContentEditable) return true;
    element = element.closest("input, textarea");
    if (!element || element.disabled || element.readOnly) return false;
    if (element.tagName === "TEXTAREA") return true;
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type);
  }
}`;

const ARROW_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};
const NAMED_KEYS = new Set([
  "Backspace",
  "Tab",
  "Enter",
  "Escape",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
]);
const MODIFIER_BITS = [
  [1, "alt"],
  [2, "control"],
  [4, "meta"],
  [8, "shift"],
] as const;

const keyCodeFor = (key: string) => {
  if ([...key].length === 1) return key;
  if (ARROW_KEYS[key]) return ARROW_KEYS[key];
  return NAMED_KEYS.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key) ? key : null;
};

/** Electron derives text from keyCode, so typed text needs separate char events. */
export const toKeyboardInputEvents = (
  params: Record<string, unknown>,
): Array<Electron.KeyboardInputEvent> => {
  const bits = typeof params["modifiers"] === "number" ? params["modifiers"] : 0;
  const modifiers = MODIFIER_BITS.flatMap(([bit, name]) => (bits & bit ? [name] : []));
  const text = typeof params["text"] === "string" ? params["text"] : "";
  const chars = [...text].map((char) => ({ type: "char" as const, keyCode: char, modifiers }));
  const keyCode = keyCodeFor(typeof params["key"] === "string" ? params["key"] : "");
  switch (params["type"]) {
    case "keyDown":
      return [...(keyCode ? [{ type: "rawKeyDown" as const, keyCode, modifiers }] : []), ...chars];
    case "rawKeyDown":
    case "keyUp":
      return keyCode ? [{ type: params["type"], keyCode, modifiers }] : [];
    case "char":
      return chars;
    default:
      return [];
  }
};

/** Only the manager's current private-entry lease may call this local input path. */
export const sendNativeSurfaceInput = async (
  webContents: Electron.WebContents,
  input: DesktopPreviewSurfaceInput,
  currentCheck: () => void,
): Promise<DesktopPreviewSurfaceInputResult> => {
  currentCheck();
  const readBoolean = async (script: string) => {
    currentCheck();
    const result: unknown = await webContents.executeJavaScript(script);
    currentCheck();
    return result === true;
  };
  if (input.type === "probe") {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y))
      throw new Error("The preview probe needs finite coordinates.");
    const editable = await readBoolean(`(${EDITABLE_AT_POINT})(${input.x}, ${input.y})`);
    currentCheck();
    return { editable };
  }
  const modifiers =
    "modifiers" in input
      ? MODIFIER_BITS.flatMap(([bit, name]) => (input.modifiers & bit ? [name] : []))
      : [];
  if (input.type === "mouse" || input.type === "wheel") {
    const zoom = webContents.getZoomFactor();
    if (!Number.isFinite(zoom) || zoom <= 0)
      throw new Error("The preview has no usable native zoom.");
    const point = { x: Math.round(input.x * zoom), y: Math.round(input.y * zoom) };
    currentCheck();
    if (input.type === "wheel") {
      webContents.sendInputEvent({
        type: "mouseWheel",
        ...point,
        deltaX: -input.deltaX * zoom,
        deltaY: -input.deltaY * zoom,
        modifiers,
      });
    } else {
      const buttons = [
        [1, "leftbuttondown"],
        [2, "rightbuttondown"],
        [4, "middlebuttondown"],
      ] as const;
      webContents.sendInputEvent({
        type:
          input.action === "down" ? "mouseDown" : input.action === "up" ? "mouseUp" : "mouseMove",
        ...point,
        ...(input.button === "none" ? {} : { button: input.button }),
        clickCount: input.clickCount,
        modifiers: [
          ...modifiers,
          ...buttons.flatMap(([bit, name]) => (input.buttons & bit ? [name] : [])),
        ],
      });
    }
    return {};
  }
  const focusedDocument = await readBoolean(`${FOCUSED_DOCUMENT} !== null`);
  currentCheck();
  if (!focusedDocument) throw new Error(CROSS_SITE_FOCUS_MESSAGE);
  if (input.type === "text") {
    currentCheck();
    await webContents.insertText(input.text.slice(0, 10_000));
    currentCheck();
    return {};
  }
  const modifier = input.modifiers & 0b0111;
  if (input.action === "down" && (modifier === 2 || modifier === 4)) {
    const key = input.key.toLowerCase();
    const command =
      key === "c"
        ? "copy"
        : key === "x"
          ? "cut"
          : key === "v"
            ? "paste"
            : key === "a"
              ? "selectAll"
              : key === "z"
                ? input.modifiers & 8
                  ? "redo"
                  : "undo"
                : key === "y" && modifier === 2
                  ? "redo"
                  : null;
    if (command) {
      currentCheck();
      webContents[command]();
      return {};
    }
  }
  for (const event of toKeyboardInputEvents({
    type: input.action === "up" ? "keyUp" : input.text ? "keyDown" : "rawKeyDown",
    key: input.key,
    text: input.text,
    modifiers: input.modifiers,
  })) {
    currentCheck();
    webContents.sendInputEvent(event);
  }
  return {};
};

const evaluate = async (debuggee: Electron.Debugger, expression: string) => {
  const reply = (await debuggee.sendCommand("Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as { readonly result?: { readonly value?: unknown } };
  return reply.result?.value;
};

let focusSequence = 0;

/** A CDP pointer press focuses the guest's native view even with focus emulation enabled. */
const sendPointerPress = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  beforeSend: (() => void) | undefined,
) => {
  const host = webContents.hostWebContents;
  if (!host || host.isDestroyed() || webContents.focusedFrame) {
    return debuggee.sendCommand(method, params, sessionId);
  }
  const key = JSON.stringify(`__t3PreviewFocus${++focusSequence}`);
  await host.executeJavaScript(`(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.tagName === "WEBVIEW") return;
    globalThis[${key}] = () => {
      delete globalThis[${key}];
      const current = document.activeElement;
      if (active.isConnected && current?.tagName === "WEBVIEW" &&
          current.getWebContentsId() === ${webContents.id}) active.focus({ preventScroll: true });
    };
  })()`);
  try {
    beforeSend?.();
    return await debuggee.sendCommand(method, params, sessionId);
  } finally {
    if (!host.isDestroyed()) {
      let restoreFocus = true;
      try {
        beforeSend?.();
      } catch {
        restoreFocus = false;
      }
      await host.executeJavaScript(
        restoreFocus ? `globalThis[${key}]?.()` : `delete globalThis[${key}]`,
      );
    }
  }
};

const pointerCommands = new WeakMap<Electron.WebContents, Promise<unknown>>();

/** Focus capture crosses processes; later pointer events must not overtake the press. */
const sendPointerCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  beforeSend: (() => void) | undefined,
) => {
  const previous = pointerCommands.get(webContents) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => {
      beforeSend?.();
      return params["type"] === "mousePressed" || params["type"] === "touchStart"
        ? sendPointerPress(webContents, debuggee, method, params, sessionId, beforeSend)
        : debuggee.sendCommand(method, params, sessionId);
    });
  pointerCommands.set(webContents, current);
  try {
    return await current;
  } finally {
    if (pointerCommands.get(webContents) === current) pointerCommands.delete(webContents);
  }
};

/** Sends one command to the guest's page, keeping reloads and input inside it. */
export const sendPageCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
  beforeSend?: () => void,
): Promise<unknown> => {
  beforeSend?.();
  if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchTouchEvent") {
    return sendPointerCommand(webContents, debuggee, method, params, sessionId, beforeSend);
  }
  if (sessionId !== undefined) return debuggee.sendCommand(method, params, sessionId);
  // Electron's debugger routes Page.reload on a webview to its embedder window.
  if (method === "Page.reload") {
    if (params["ignoreCache"] === true) webContents.reloadIgnoringCache();
    else webContents.reload();
    return {};
  }
  if (!FOCUS_ROUTED_INPUT.has(method) || webContents.focusedFrame) {
    return debuggee.sendCommand(method, params);
  }
  if ((await evaluate(debuggee, `${FOCUSED_DOCUMENT} !== null`)) !== true) {
    throw new Error(CROSS_SITE_FOCUS_MESSAGE);
  }
  switch (method) {
    case "Input.insertText":
      await webContents.insertText(typeof params["text"] === "string" ? params["text"] : "");
      return {};
    case "Input.dispatchKeyEvent": {
      for (const event of toKeyboardInputEvents(params)) webContents.sendInputEvent(event);
      const commands = Array.isArray(params["commands"])
        ? params["commands"].filter((command) => EDITING_COMMANDS.has(command))
        : [];
      // Runs after the page handles the keys, so the reply also waits for them.
      await evaluate(
        debuggee,
        `(() => { const doc = ${FOCUSED_DOCUMENT}; for (const name of ${JSON.stringify(commands)}) doc?.execCommand(name); return 0; })()`,
      );
      return {};
    }
    default:
      throw new Error(`${method} needs the preview to have focus.`);
  }
};
