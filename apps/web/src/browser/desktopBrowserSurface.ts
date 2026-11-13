import type {
  DesktopPreviewBridge,
  DesktopPreviewSurfaceAck,
  DesktopPreviewSurfaceFrame,
  DesktopPreviewSurfaceFocusRequest,
  DesktopPreviewSurfaceState,
} from "@t3tools/contracts";
import { create } from "zustand";

const useHostStates = create<{
  readonly hostedEnvironmentIds: ReadonlyArray<string>;
  readonly hostedEnvironmentsOwner: symbol | null;
  readonly byTabId: ReadonlyMap<
    string,
    {
      readonly owner: symbol;
      readonly state: DesktopPreviewSurfaceState;
      readonly revision: number;
    }
  >;
}>(() => ({ byTabId: new Map(), hostedEnvironmentIds: [], hostedEnvironmentsOwner: null }));

export function readDesktopBrowserHostedEnvironmentIds() {
  return useHostStates.getState().hostedEnvironmentIds;
}

export function useDesktopBrowserHostedEnvironmentIds() {
  return useHostStates((states) => states.hostedEnvironmentIds);
}

export function subscribeDesktopBrowserHostedEnvironments(
  bridge: Pick<DesktopPreviewBridge, "getHostedEnvironmentIds" | "onHostedEnvironmentsChange">,
) {
  const owner = Symbol("hosted-environments");
  let receivedEvent = false;
  let disposed = false;
  useHostStates.setState({ hostedEnvironmentIds: [], hostedEnvironmentsOwner: owner });
  const update = (ids: ReadonlyArray<string>) => {
    if (disposed || useHostStates.getState().hostedEnvironmentsOwner !== owner) return;
    const knownIds = useHostStates.getState().hostedEnvironmentIds;
    const hostedEnvironmentIds = [...new Set([...knownIds, ...ids])];
    // Main revokes input on disconnect; keep the guest's host assignment until this scope ends.
    if (hostedEnvironmentIds.length !== knownIds.length)
      useHostStates.setState({ hostedEnvironmentIds });
  };
  const unsubscribe = bridge.onHostedEnvironmentsChange((ids) => {
    receivedEvent = true;
    update(ids);
  });
  void bridge
    .getHostedEnvironmentIds()
    .then((ids) => {
      if (!receivedEvent) update(ids);
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unsubscribe();
    if (useHostStates.getState().hostedEnvironmentsOwner === owner)
      useHostStates.setState({ hostedEnvironmentIds: [], hostedEnvironmentsOwner: null });
  };
}

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
  readonly preparePrivateEntry: (signal: AbortSignal) => Promise<void>;
  readonly onPreparationChange: (active: boolean) => void;
  readonly bridge: DesktopPreviewBridge["surface"];
  readonly tabId: string;
  readonly surfaceId: string;
  readonly webContentsId: number;
}) {
  let disposed = false;
  let preparation: {
    readonly request: DesktopPreviewSurfaceFocusRequest;
    readonly abort: AbortController;
    released: boolean;
    focused: boolean;
    finishing: boolean;
  } | null = null;
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
  const finishPreparation = () => {
    const current = preparation;
    preparation = null;
    if (!current) return;
    current.abort.abort();
    input.onPreparationChange(false);
  };
  const canFocus = () =>
    input.canFocus() ||
    (preparation?.released === true &&
      input.frame()?.generation === preparation.request.generation);
  const surfaceFocused = () => {
    const keyboard = input.keyboardInput();
    return (
      document.hasFocus() &&
      ((keyboard !== null && document.activeElement === keyboard) ||
        document.activeElement === input.canvas)
    );
  };
  const focused = () => !disposed && canFocus() && surfaceFocused();
  const report = (blurred = false) => {
    const frame = input.frame();
    if (disposed || !frame || !owns(frame)) return;
    if (
      preparation &&
      (frame.generation !== preparation.request.generation ||
        (preparation.finishing && frame.privateEntry))
    )
      finishPreparation();
    void input.bridge
      .focus({ ...identity(frame), focused: !blurred && focused() })
      .catch(() => undefined);
  };
  const restore = (request: DesktopPreviewSurfaceFocusRequest) => {
    if (disposed || !owns(request)) return;
    if (request.preparation === "finish") {
      if (preparation?.request.requestId !== request.requestId) return;
      if (request.privateEntry && !input.frame()?.privateEntry) preparation.finishing = true;
      else finishPreparation();
      return;
    }
    const frame = input.frame();
    const current =
      frame &&
      owns(frame) &&
      frame.sequence === request.sequence &&
      frame.generation === request.generation;
    if (request.preparation === "begin") {
      const acknowledge = (prepared: boolean) =>
        input.bridge.focus({
          ...identity(request),
          requestId: request.requestId,
          prepared,
          focused: false,
        });
      if (!current || preparation || !focused()) {
        void acknowledge(false).catch(() => undefined);
        return;
      }
      const pending = {
        request,
        abort: new AbortController(),
        released: false,
        focused: false,
        finishing: false,
      };
      preparation = pending;
      input.onPreparationChange(true);
      void input.preparePrivateEntry(pending.abort.signal).then(
        async () => {
          const latest = input.frame();
          if (
            disposed ||
            preparation !== pending ||
            !latest ||
            !owns(latest) ||
            latest.generation !== request.generation ||
            !surfaceFocused()
          ) {
            if (preparation === pending) finishPreparation();
            await acknowledge(false).catch(() => undefined);
            return;
          }
          pending.released = true;
          await acknowledge(true).catch(finishPreparation);
        },
        async () => {
          if (preparation !== pending) return;
          finishPreparation();
          await acknowledge(false).catch(() => undefined);
        },
      );
      return;
    }
    if (current && canFocus()) input.keyboardInput()?.focus({ preventScroll: true });
    const confirmed = Boolean(current && focused());
    if (preparation && confirmed) preparation.focused = true;
    void input.bridge
      .focus({
        ...identity(request),
        requestId: request.requestId,
        focused: confirmed,
      })
      .catch(finishPreparation);
  };
  const changed = () => report();
  const blurred = () => {
    finishPreparation();
    report(true);
  };
  const leftSurface = (event: FocusEvent) => {
    if (event.target === input.keyboardInput() || event.target === input.canvas) {
      if (event.relatedTarget !== input.keyboardInput() && event.relatedTarget !== input.canvas)
        finishPreparation();
      report(true);
    }
  };
  const unsubscribe = input.bridge.onFocusRequest(restore);
  document.addEventListener("focusin", changed);
  document.addEventListener("focusout", leftSurface);
  document.defaultView?.addEventListener("focus", changed);
  document.defaultView?.addEventListener("blur", blurred);
  return {
    isFocused: focused,
    report: changed,
    connectionLost: () => {
      if (preparation && !preparation.focused) finishPreparation();
    },
    stop: () => {
      finishPreparation();
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

export function createLocalBrowserSurfaceQueue() {
  let stopped = false;
  let pending = 0;
  let tail = Promise.resolve();
  return {
    run<A>(operation: () => Promise<A>): Promise<A> {
      if (stopped || pending >= 128) return Promise.reject(new Error("Browser surface is busy."));
      pending++;
      const result = tail.then(() => {
        if (stopped) throw new Error("Browser surface closed.");
        return operation();
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => pending--);
    },
    stop() {
      stopped = true;
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
  readonly isFocused: () => boolean;
  readonly onPainted: (frame: LocalBrowserFrame) => void;
  readonly onError: () => void;
  readonly queue?: ReturnType<typeof createLocalBrowserSurfaceQueue>;
}) {
  let disposed = false;
  let decoding = false;
  let generation = -1;
  let sequence = -1;
  let pending: DesktopPreviewSurfaceFrame | null = null;
  const acknowledge = (frame: DesktopPreviewSurfaceAck, painted = false) =>
    input.bridge
      .ack({
        tabId: frame.tabId,
        surfaceId: frame.surfaceId,
        webContentsId: frame.webContentsId,
        sequence: frame.sequence,
        generation: frame.generation,
        focused: painted && input.isFocused(),
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
        let paintStarted = false;
        const paint = async () => {
          paintStarted = true;
          let bitmap: ImageBitmap | null = null;
          let ackAttempted = false;
          try {
            bitmap = await createImageBitmap(
              new Blob([new Uint8Array(next.png)], { type: "image/png" }),
            );
            if (disposed || generation !== next.generation || sequence !== next.sequence) return;
            const context = input.canvas.getContext("2d");
            if (!context) throw new Error("Browser canvas is unavailable");
            input.canvas.width = bitmap.width;
            input.canvas.height = bitmap.height;
            context.drawImage(bitmap, 0, 0);
            input.onPrivateEntry(next.privateEntry);
            ackAttempted = true;
            if (!(await acknowledge(next, true)))
              throw new Error("Browser frame acknowledgement failed");
            if (disposed || generation !== next.generation) return;
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
        };
        if (input.queue)
          await input.queue.run(paint).catch(async () => {
            if (!paintStarted) await acknowledge(next);
            if (!disposed) input.onError();
          });
        else await paint();
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
