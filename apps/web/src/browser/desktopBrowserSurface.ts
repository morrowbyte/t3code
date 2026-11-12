import type {
  DesktopPreviewBridge,
  DesktopPreviewSurfaceAck,
  DesktopPreviewSurfaceFrame,
  DesktopPreviewSurfaceFocusRequest,
  DesktopPreviewSurfaceState,
} from "@t3tools/contracts";
import { create } from "zustand";

const useHostStates = create<{
  readonly byTabId: ReadonlyMap<
    string,
    {
      readonly owner: symbol;
      readonly state: DesktopPreviewSurfaceState;
      readonly revision: number;
    }
  >;
}>(() => ({ byTabId: new Map() }));

export function useDesktopBrowserHostState(tabId: string | null | undefined) {
  return useHostStates((states) => (tabId ? (states.byTabId.get(tabId)?.state ?? null) : null));
}

export function useDesktopBrowserHostRevision(tabId: string) {
  return useHostStates((states) => states.byTabId.get(tabId)?.revision ?? 0);
}

export function reconnectDesktopBrowserHost(tabId: string) {
  useHostStates.setState((current) => {
    const entry = current.byTabId.get(tabId);
    if (!entry) return current;
    return {
      byTabId: new Map(current.byTabId).set(tabId, { ...entry, revision: entry.revision + 1 }),
    };
  });
}

export function acquireDesktopBrowserHostState(tabId: string) {
  const owner = Symbol(tabId);
  let released = false;
  const update = (state: DesktopPreviewSurfaceState) => {
    if (released) return;
    useHostStates.setState((current) => {
      const previous = current.byTabId.get(tabId);
      if (previous && previous.owner !== owner) return current;
      if (
        previous?.state.kind === state.kind &&
        previous.state.webContentsId === state.webContentsId &&
        previous.state.privateEntry === state.privateEntry
      )
        return current;
      return {
        byTabId: new Map(current.byTabId).set(tabId, {
          owner,
          state,
          revision: previous?.revision ?? 0,
        }),
      };
    });
  };
  update({ kind: "pending", webContentsId: null, privateEntry: false });
  return {
    update,
    release: () => {
      released = true;
      useHostStates.setState((current) => {
        if (current.byTabId.get(tabId)?.owner !== owner) return current;
        const byTabId = new Map(current.byTabId);
        byTabId.delete(tabId);
        return { byTabId };
      });
    },
  };
}

export interface LocalBrowserFrame extends DesktopPreviewSurfaceAck {
  readonly width: number;
  readonly height: number;
  readonly privateEntry: boolean;
}

export function createLocalBrowserFocusController(input: {
  readonly canvas: HTMLCanvasElement;
  readonly keyboardInput: () => HTMLTextAreaElement | null;
  readonly frame: () => LocalBrowserFrame | null;
  readonly canFocus: () => boolean;
  readonly bridge: DesktopPreviewBridge["surface"];
  readonly tabId: string;
  readonly surfaceId: string;
  readonly webContentsId: number;
}) {
  let disposed = false;
  const document = input.canvas.ownerDocument;
  const identity = (frame: DesktopPreviewSurfaceAck) => ({
    tabId: frame.tabId,
    surfaceId: frame.surfaceId,
    webContentsId: frame.webContentsId,
    sequence: frame.sequence,
    generation: frame.generation,
  });
  const owns = (frame: DesktopPreviewSurfaceAck) =>
    frame.tabId === input.tabId &&
    frame.surfaceId === input.surfaceId &&
    frame.webContentsId === input.webContentsId;
  const focused = () => {
    const keyboard = input.keyboardInput();
    return (
      !disposed &&
      input.canFocus() &&
      document.hasFocus() &&
      ((keyboard !== null && document.activeElement === keyboard) ||
        document.activeElement === input.canvas)
    );
  };
  const report = (blurred = false) => {
    const frame = input.frame();
    if (disposed || !frame || !owns(frame)) return;
    void input.bridge
      .focus({ ...identity(frame), focused: !blurred && focused() })
      .catch(() => undefined);
  };
  const restore = (request: DesktopPreviewSurfaceFocusRequest) => {
    if (disposed || !owns(request)) return;
    const frame = input.frame();
    const current =
      frame &&
      owns(frame) &&
      frame.sequence === request.sequence &&
      frame.generation === request.generation;
    if (current && input.canFocus()) input.keyboardInput()?.focus({ preventScroll: true });
    void input.bridge
      .focus({
        ...identity(request),
        requestId: request.requestId,
        focused: Boolean(current && focused()),
      })
      .catch(() => undefined);
  };
  const changed = () => report();
  const blurred = () => report(true);
  const leftSurface = (event: FocusEvent) => {
    if (event.target === input.keyboardInput() || event.target === input.canvas) report(true);
  };
  const unsubscribe = input.bridge.onFocusRequest(restore);
  document.addEventListener("focusin", changed);
  document.addEventListener("focusout", leftSurface);
  document.defaultView?.addEventListener("focus", changed);
  document.defaultView?.addEventListener("blur", blurred);
  return {
    report: changed,
    stop: () => {
      report(true);
      disposed = true;
      unsubscribe();
      document.removeEventListener("focusin", changed);
      document.removeEventListener("focusout", leftSurface);
      document.defaultView?.removeEventListener("focus", changed);
      document.defaultView?.removeEventListener("blur", blurred);
    },
  };
}

export function createLocalBrowserFrameReceiver(input: {
  readonly canvas: HTMLCanvasElement;
  readonly bridge: DesktopPreviewBridge["surface"];
  readonly tabId: string;
  readonly surfaceId: string;
  readonly webContentsId: number;
  readonly onPrivateEntry: (active: boolean) => void;
  readonly onPainted: (frame: LocalBrowserFrame) => void;
  readonly onError: () => void;
}) {
  let disposed = false;
  let decoding = false;
  let generation = -1;
  let sequence = -1;
  let pending: DesktopPreviewSurfaceFrame | null = null;
  const acknowledge = (frame: DesktopPreviewSurfaceAck) =>
    input.bridge
      .ack({
        tabId: frame.tabId,
        surfaceId: frame.surfaceId,
        webContentsId: frame.webContentsId,
        sequence: frame.sequence,
        generation: frame.generation,
      })
      .then(
        () => true,
        () => false,
      );
  const receive = async (frame: DesktopPreviewSurfaceFrame) => {
    if (frame.tabId !== input.tabId || frame.surfaceId !== input.surfaceId) return;
    if (
      disposed ||
      frame.webContentsId !== input.webContentsId ||
      frame.generation < generation ||
      frame.sequence <= sequence
    ) {
      await acknowledge(frame);
      return;
    }
    generation = frame.generation;
    sequence = frame.sequence;
    // Block exports before decoding: the preceding canvas may still show the last public frame.
    if (frame.privateEntry) input.onPrivateEntry(true);
    const dropped = pending;
    pending = frame;
    if (dropped) void acknowledge(dropped);
    if (decoding) return;
    decoding = true;
    try {
      while (pending) {
        const next = pending;
        pending = null;
        let bitmap: ImageBitmap | null = null;
        let ackAttempted = false;
        try {
          bitmap = await createImageBitmap(
            new Blob([new Uint8Array(next.png)], { type: "image/png" }),
          );
          if (disposed || generation !== next.generation || sequence !== next.sequence) continue;
          const context = input.canvas.getContext("2d");
          if (!context) throw new Error("Browser canvas is unavailable");
          input.canvas.width = bitmap.width;
          input.canvas.height = bitmap.height;
          context.drawImage(bitmap, 0, 0);
          input.onPrivateEntry(next.privateEntry);
          ackAttempted = true;
          if (!(await acknowledge(next))) throw new Error("Browser frame acknowledgement failed");
          if (disposed || generation !== next.generation || sequence !== next.sequence) continue;
          input.onPainted({
            tabId: next.tabId,
            surfaceId: next.surfaceId,
            webContentsId: next.webContentsId,
            sequence: next.sequence,
            generation: next.generation,
            width: next.width,
            height: next.height,
            privateEntry: next.privateEntry,
          });
        } catch {
          if (!disposed) input.onError();
        } finally {
          bitmap?.close();
          if (!ackAttempted) await acknowledge(next);
        }
      }
    } finally {
      decoding = false;
    }
  };
  return {
    receive,
    stop: () => {
      disposed = true;
      if (pending) void acknowledge(pending);
      pending = null;
    },
  };
}
