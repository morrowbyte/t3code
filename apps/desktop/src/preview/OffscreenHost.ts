import * as NodeZlib from "node:zlib";
import type {
  DesktopPreviewSurfaceAck,
  DesktopPreviewSurfaceFocusInput,
  DesktopPreviewSurfaceFocusRequest,
  DesktopPreviewSurfaceFrame,
  DesktopPreviewSurfacePresentation,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import { BrowserWindow } from "electron";

import {
  PREVIEW_LOCAL_SURFACE_FOCUS_REQUEST_CHANNEL,
  PREVIEW_LOCAL_SURFACE_FRAME_CHANNEL,
} from "../ipc/channels.ts";

const FRAME_RATE = 20;
const BITMAP_OPTIONS: Electron.ToBitmapOptions = {
  colorSpace: { primaries: "invalid", transfer: "invalid", matrix: "invalid", range: "invalid" },
};

interface OffscreenHostOptions {
  readonly tabId: string;
  readonly partition: string;
  readonly preload: string;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly deviceScaleFactor: number;
  readonly additionalArguments: ReadonlyArray<string>;
  readonly owner: BrowserWindow;
  readonly isCurrent: () => boolean;
  readonly isPrivateEntry: (wc: Electron.WebContents) => boolean;
  readonly onGone: () => void;
}

export const createOffscreenHost = (options: OffscreenHostOptions) => {
  let viewport = options.viewport;
  let fillSize = { width: 1280, height: 800 };
  let cssSize = viewport._tag === "fill" ? fillSize : viewport;
  const window = new BrowserWindow({
    width: 1,
    height: 1,
    useContentSize: true,
    show: false,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: {
      partition: options.partition,
      preload: options.preload,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: false,
      disableHtmlFullscreenWindowResize: true,
      backgroundThrottling: false,
      zoomFactor: options.zoomFactor,
      additionalArguments: [...options.additionalArguments],
      offscreen: { useSharedTexture: false, deviceScaleFactor: options.deviceScaleFactor },
    },
  });
  const wc = window.webContents;
  let generation = 0;
  let sequence = 0;
  let disposed = false;
  let unusable = false;
  let surfaceId: string | undefined;
  let pending: DesktopPreviewSurfaceAck | undefined;
  // ACKs may discard frames; focus additionally requires confirmation of the painted canvas.
  let presented: DesktopPreviewSurfaceAck | undefined;
  let lastFingerprint: string | undefined;
  let dirtyWhilePending = false;
  let rasterSize: { width: number; height: number } | undefined;
  let zoomFactor = options.zoomFactor;
  let capturing: Promise<Electron.NativeImage> | undefined;
  let captureHolds = 0;
  let inputFrameHolds = 0;
  let inputFrameReleased: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let privateEntry = options.isPrivateEntry(wc);
  let focusProof: DesktopPreviewSurfaceAck | undefined;
  let focusRequest:
    | {
        readonly identity: DesktopPreviewSurfaceFocusRequest;
        readonly complete: (focused: boolean) => void;
      }
    | undefined;
  let preparation:
    | {
        readonly identity: DesktopPreviewSurfaceFocusRequest;
        complete: ((prepared: boolean) => void) | undefined;
      }
    | undefined;

  const finishPreparation = () => {
    const current = preparation;
    preparation = undefined;
    if (!current) return;
    const complete = current.complete;
    current.complete = undefined;
    complete?.(false);
    try {
      options.owner.webContents.send(PREVIEW_LOCAL_SURFACE_FOCUS_REQUEST_CHANNEL, {
        ...current.identity,
        preparation: "finish",
        privateEntry: options.isPrivateEntry(wc),
      });
    } catch {
      // A closed renderer cannot retain the preparation.
    }
  };

  const clearFocus = () => {
    focusProof = undefined;
    const request = focusRequest;
    focusRequest = undefined;
    request?.complete(false);
  };
  const clearSurfaceState = () => {
    finishPreparation();
    clearFocus();
  };

  const alive = () => !disposed && !unusable && !window.isDestroyed() && !wc.isDestroyed();
  const destroyWhenDrained = () => {
    if (disposed && captureHolds === 0 && !window.isDestroyed()) window.destroy();
  };
  const acquireCaptureHold = () => {
    if (!alive() || !options.isCurrent()) throw new Error("The offscreen browser host is closed.");
    captureHolds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      captureHolds -= 1;
      destroyWhenDrained();
    };
  };
  const visible = () => alive() && surfaceId !== undefined && options.isCurrent();
  const holdInputFrame = () => {
    if (!visible()) throw new Error("The local browser surface is unavailable.");
    inputFrameReleased ??= Promise.withResolvers<void>();
    inputFrameHolds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inputFrameHolds -= 1;
      if (inputFrameHolds !== 0) return;
      const waiting = inputFrameReleased;
      inputFrameReleased = undefined;
      waiting?.resolve();
    };
  };
  const invalidate = () => {
    if (visible()) wc.invalidate();
  };
  const revise = () => {
    clearSurfaceState();
    generation += 1;
    presented = undefined;
    lastFingerprint = undefined;
    dirtyWhilePending = pending !== undefined;
  };
  const refreshPrivacy = () => {
    const next = options.isPrivateEntry(wc);
    if (next === privateEntry) return;
    privateEntry = next;
    lastFingerprint = undefined;
    dirtyWhilePending = pending !== undefined;
    invalidate();
  };
  const resize = () => {
    if (!alive()) throw new Error("The offscreen browser host is closed.");
    const next = viewport._tag === "fill" ? fillSize : viewport;
    const nextZoom = wc.getZoomFactor();
    const width = Math.max(1, Math.round(next.width * nextZoom));
    const height = Math.max(1, Math.round(next.height * nextZoom));
    if (
      rasterSize?.width === width &&
      rasterSize.height === height &&
      cssSize.width === next.width &&
      cssSize.height === next.height &&
      zoomFactor === nextZoom
    )
      return;
    cssSize = { width: next.width, height: next.height };
    zoomFactor = nextZoom;
    rasterSize = { width, height };
    revise();
    // The constructor can clamp a hidden window to the display; this setter must run afterwards.
    window.setContentSize(width, height);
    invalidate();
  };
  const matches = (input: DesktopPreviewSurfaceAck, frame: DesktopPreviewSurfaceAck | undefined) =>
    frame !== undefined &&
    input.tabId === options.tabId &&
    input.surfaceId === frame.surfaceId &&
    input.webContentsId === wc.id &&
    input.sequence === frame.sequence &&
    input.generation === frame.generation;
  const matchesPresented = (input: DesktopPreviewSurfaceAck) =>
    visible() &&
    input.generation === generation &&
    wc.getZoomFactor() === zoomFactor &&
    matches(input, presented);
  const ownerFocused = () => visible() && options.owner.isFocused();
  const hasFocus = () => {
    if (!ownerFocused()) {
      clearSurfaceState();
      return false;
    }
    if (focusProof === undefined) return false;
    if (!matchesPresented(focusProof)) {
      clearSurfaceState();
      return false;
    }
    return true;
  };
  const paint = (_event: unknown, _dirty: Electron.Rectangle, image: Electron.NativeImage) => {
    if (!visible()) return;
    try {
      const beforeResize = generation;
      resize();
      if (generation !== beforeResize) return;
      const size = image.getSize();
      if (size.width <= 0 || size.height <= 0) return;
      refreshPrivacy();
      const bitmap = image.toBitmap(BITMAP_OPTIONS);
      if (bitmap.byteLength === 0) return;
      const fingerprint = `${generation}:${size.width}x${size.height}:${privateEntry}:${NodeZlib.crc32(bitmap)}`;
      if (pending) {
        dirtyWhilePending = fingerprint !== lastFingerprint;
        return;
      }
      if (fingerprint === lastFingerprint) return;
      const png = image.toPNG();
      if (!visible() || !surfaceId) return;
      const identity: DesktopPreviewSurfaceAck = {
        tabId: options.tabId,
        surfaceId,
        webContentsId: wc.id,
        sequence: ++sequence,
        generation,
      };
      const frame: DesktopPreviewSurfaceFrame = {
        ...identity,
        width: cssSize.width,
        height: cssSize.height,
        privateEntry,
        png: Uint8Array.from(png),
      };
      pending = identity;
      lastFingerprint = fingerprint;
      dirtyWhilePending = false;
      options.owner.webContents.send(PREVIEW_LOCAL_SURFACE_FRAME_CHANNEL, frame);
    } catch {
      surfaceId = undefined;
      pending = undefined;
      presented = undefined;
      clearSurfaceState();
    }
  };
  const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!event.isMainFrame) return;
    revise();
    invalidate();
  };
  const gone = () => {
    if (unusable) return;
    unusable = true;
    revise();
    surfaceId = undefined;
    pending = undefined;
    presented = undefined;
    options.onGone();
  };
  try {
    wc.setZoomFactor(options.zoomFactor);
    resize();
    wc.setFrameRate(FRAME_RATE);
    // Hidden hosts still render for native/server captures; only local encoding requires visibility.
    wc.startPainting();
    wc.on("paint", paint);
    wc.on("did-start-navigation", navigation);
    wc.on("render-process-gone", gone);
    wc.on("destroyed", gone);
    wc.on("zoom-changed", resize);
    options.owner.on("blur", clearSurfaceState);
    options.owner.on("hide", clearSurfaceState);
    options.owner.on("minimize", clearSurfaceState);
    options.owner.on("closed", clearSurfaceState);
    options.owner.webContents.on("did-start-navigation", clearSurfaceState);
    options.owner.webContents.on("render-process-gone", clearSurfaceState);
    options.owner.webContents.on("destroyed", clearSurfaceState);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }

  const acknowledge = (input: DesktopPreviewSurfaceAck): void | Promise<void> => {
    if (inputFrameReleased) {
      return inputFrameReleased.promise.then(() => acknowledge(input));
    }
    if (!matches(input, pending)) return;
    const acknowledged = pending;
    pending = undefined;
    if (
      acknowledged &&
      acknowledged.generation === generation &&
      acknowledged.surfaceId === surfaceId &&
      visible()
    ) {
      clearFocus();
      presented = acknowledged;
      if (input.focused === true && ownerFocused()) focusProof = acknowledged;
    }
    refreshPrivacy();
    if (!dirtyWhilePending) return;
    dirtyWhilePending = false;
    invalidate();
  };

  return {
    window,
    webContents: wc,
    owner: options.owner,
    partition: options.partition,
    preload: options.preload,
    isAlive: alive,
    refreshPrivacy,
    hasFocus,
    presentedFrame: () => (presented && matchesPresented(presented) ? presented : undefined),
    focus: (input: DesktopPreviewSurfaceFocusInput) => {
      if (
        input.tabId !== options.tabId ||
        input.webContentsId !== wc.id ||
        input.surfaceId !== surfaceId
      )
        return;
      if (input.prepared !== undefined) {
        const current = preparation;
        if (
          !current ||
          input.requestId !== current.identity.requestId ||
          input.generation !== generation ||
          !matches(input, current.identity) ||
          !ownerFocused()
        )
          return;
        const complete = current.complete;
        current.complete = undefined;
        complete?.(input.prepared);
        return;
      }
      if (!input.focused) {
        clearFocus();
        return;
      }
      if (!ownerFocused() || !matchesPresented(input)) {
        clearFocus();
        return;
      }
      if (
        input.requestId !== undefined &&
        (!focusRequest ||
          input.requestId !== focusRequest.identity.requestId ||
          !matches(input, focusRequest.identity))
      ) {
        focusProof = undefined;
        return;
      }
      focusProof = { ...input };
      if (input.requestId !== undefined && focusRequest) {
        const request = focusRequest;
        focusRequest = undefined;
        request.complete(true);
      }
    },
    requestFocus: (
      identity: DesktopPreviewSurfaceFocusRequest,
      complete: (focused: boolean) => void,
    ) => {
      if (focusRequest || !ownerFocused() || !matchesPresented(identity)) {
        throw new Error("The local browser surface cannot restore focus.");
      }
      focusProof = undefined;
      const request = { identity, complete };
      focusRequest = request;
      try {
        options.owner.webContents.send(PREVIEW_LOCAL_SURFACE_FOCUS_REQUEST_CHANNEL, identity);
      } catch (error) {
        clearFocus();
        throw error;
      }
      return () => {
        if (focusRequest === request) clearFocus();
      };
    },
    requestPreparation: (
      identity: DesktopPreviewSurfaceFocusRequest,
      complete: (prepared: boolean) => void,
    ) => {
      if (preparation || !ownerFocused() || !matchesPresented(identity))
        throw new Error("The local browser surface cannot prepare private entry.");
      preparation = { identity, complete };
      try {
        options.owner.webContents.send(PREVIEW_LOCAL_SURFACE_FOCUS_REQUEST_CHANNEL, {
          ...identity,
          preparation: "begin",
        });
      } catch (error) {
        finishPreparation();
        throw error;
      }
    },
    finishPreparation,
    captureRevision: () => {
      if (alive()) resize();
      return generation;
    },
    acquireCaptureHold,
    resize,
    getViewport: () => viewport,
    setViewport: (setting: PreviewViewportSetting) => {
      viewport = setting;
      resize();
    },
    present: (input: DesktopPreviewSurfacePresentation) => {
      if (!input.visible) {
        if (input.surfaceId !== surfaceId) return;
        clearSurfaceState();
        surfaceId = undefined;
        pending = undefined;
        presented = undefined;
        lastFingerprint = undefined;
        dirtyWhilePending = false;
        return;
      }
      if (surfaceId !== input.surfaceId) {
        clearSurfaceState();
        surfaceId = input.surfaceId;
        pending = undefined;
        presented = undefined;
        lastFingerprint = undefined;
        dirtyWhilePending = false;
      }
      refreshPrivacy();
      if (input.width !== undefined || input.height !== undefined) {
        fillSize = {
          width: input.width ?? fillSize.width,
          height: input.height ?? fillSize.height,
        };
        resize();
      }
      wc.startPainting();
      invalidate();
    },
    ack: acknowledge,
    holdInputFrame,
    matchesPresented,
    capturePage: () => {
      if (!alive() || capturing) throw new Error("The offscreen browser capture is unavailable.");
      resize();
      const release = acquireCaptureHold();
      let capture: Promise<Electron.NativeImage>;
      try {
        capture = wc.capturePage();
      } catch (error) {
        release();
        throw error;
      }
      capturing = capture;
      void capture
        .finally(() => {
          if (capturing === capture) capturing = undefined;
          release();
        })
        .catch(() => {});
      return capture;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const waitingInput = inputFrameReleased;
      inputFrameReleased = undefined;
      waitingInput?.resolve();
      clearSurfaceState();
      generation += 1;
      surfaceId = undefined;
      pending = undefined;
      presented = undefined;
      lastFingerprint = undefined;
      dirtyWhilePending = false;
      wc.off("paint", paint);
      wc.off("did-start-navigation", navigation);
      wc.off("render-process-gone", gone);
      wc.off("destroyed", gone);
      wc.off("zoom-changed", resize);
      options.owner.off("blur", clearSurfaceState);
      options.owner.off("hide", clearSurfaceState);
      options.owner.off("minimize", clearSurfaceState);
      options.owner.off("closed", clearSurfaceState);
      options.owner.webContents.off("did-start-navigation", clearSurfaceState);
      options.owner.webContents.off("render-process-gone", clearSurfaceState);
      options.owner.webContents.off("destroyed", clearSurfaceState);
      if (!wc.isDestroyed()) wc.stopPainting();
      // Timeouts and relay detaches do not settle Chromium's original capture callback.
      destroyWhenDrained();
    },
  };
};

export type OffscreenHost = ReturnType<typeof createOffscreenHost>;
