import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamControlLabel,
  previewStreamModifiers,
  type PreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamDownload,
  type PreviewStreamFileChooser,
  uploadPreviewStreamFiles,
  type PreviewStreamInput,
  type PreviewStreamMouseButton,
  type PreviewStreamPointer,
  type PreviewStreamViewport,
  previewStreamHostSetupMessage,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type EnvironmentId,
  type DesktopPreviewSurfaceInput,
  type PreviewAnnotationPayload,
  type PreviewAnnotationScreenshot,
  type PreviewStreamHostSetup,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { AgentCursorMark } from "~/components/preview/AgentBrowserCursor";
import { CommandBlock } from "~/components/CommandBlock";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { randomUUID, cn } from "~/lib/utils";
import { refreshPreviewStreamAccess, usePreviewStreamAccess } from "~/state/previewStream";
import { observeResize } from "~/lib/observeResize";
import { previewBridge } from "~/components/preview/previewBridge";
import { useStableCallback } from "~/hooks/useStableCallback";

import {
  createLocalBrowserFrameReceiver,
  createLocalBrowserFocusController,
  reconnectDesktopBrowserHost,
  type LocalBrowserFrame,
  useDesktopBrowserHostState,
} from "./desktopBrowserSurface";
import { OffscreenBrowserViewport } from "./OffscreenBrowserViewport";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { resolveFittedBrowserViewport } from "./browserViewportLayout";
import { useBrowserLayoutZoomFactor } from "./useBrowserLayoutZoomFactor";

export interface ServerBrowserHandle {
  readonly navigate: (url: string) => void;
  readonly history: (delta: -1 | 1) => void;
  readonly reload: (options?: { readonly ignoreCache?: boolean }) => void;
  readonly viewport: (setting: PreviewViewportSetting) => void;
  readonly canvas: () => HTMLCanvasElement | null;
  readonly screenshot: () => PreviewAnnotationScreenshot | null;
}

const RESIZE_THROTTLE_MS = 150;
// Reuse nearby probes when a slow link would return the tap's answer after it ends.
const PROBE_REUSE_PX = 24;
const PROBE_REUSE_MS = 10_000;
// Android keyboards report Backspace as text deletion, so keep a deletable sentinel.
const INPUT_SENTINEL = "\u200b";
const BACKSPACE = { key: "Backspace", code: "Backspace", keyCode: 8 } as const;
const DELETE = { key: "Delete", code: "Delete", keyCode: 46 } as const;
const COPY = { key: "c", code: "KeyC", keyCode: 67 } as const;
const CUT = { key: "x", code: "KeyX", keyCode: 88 } as const;
const CTRL = 2;
const MAX_UNAUTHORIZED_REFUSALS = 3;
const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;
const WHEEL_LINE_PX = 16;

type MouseInput = Extract<PreviewStreamInput, { type: "mouse" }>;
type WheelInput = Extract<PreviewStreamInput, { type: "wheel" }>;

const isLocalSurfaceInput = (
  input: PreviewStreamInput,
): input is PreviewStreamInput & DesktopPreviewSurfaceInput =>
  input.type === "mouse" ||
  input.type === "wheel" ||
  input.type === "key" ||
  input.type === "text" ||
  input.type === "probe";

interface PagePoint {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

interface TouchGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  panning: boolean;
}

interface TouchProbe {
  readonly x: number;
  readonly y: number;
  editable: boolean | null;
  answered: boolean;
  tapped: boolean;
}

const buttonOf = (button: number): PreviewStreamMouseButton =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";

const pressedButtonOf = (buttons: number): PreviewStreamMouseButton =>
  buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";

// Mouse thumb buttons: `button === 3` is Back, `button === 4` is Forward.
const historyDeltaOf = (button: number): -1 | 1 | null =>
  button === 3 ? -1 : button === 4 ? 1 : null;

/** Browsers may refuse a write that arrives after the key press; a toast button is a fresh gesture. */
async function copyPageText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const id = toastManager.add({
      type: "info",
      title: "The page copied text",
      actionProps: {
        children: "Copy",
        onClick: () => {
          toastManager.close(id);
          void navigator.clipboard.writeText(text).catch(() => undefined);
        },
      },
    });
  }
}

function offerDownload(download: PreviewStreamDownload) {
  const id = toastManager.add({
    type: "info",
    title: `Downloaded ${download.fileName}`,
    actionProps: {
      children: "Save",
      onClick: () => {
        toastManager.close(id);
        const anchor = document.createElement("a");
        anchor.href = download.url;
        anchor.download = download.fileName;
        anchor.click();
      },
    },
  });
}

interface ServerBrowserSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly runtimeTabId?: string;
  readonly viewport?: PreviewViewportSetting;
  readonly zoomFactor?: number;
  readonly fitSourceContent?: boolean;
  readonly visible: boolean;
  readonly mode?: "stream" | "native";
  readonly children?: ReactNode | ((interactive: boolean) => ReactNode);
  readonly followSize?: boolean;
  readonly picking?: boolean;
  readonly selectionScope?: string;
  readonly onSelection?: (annotation: PreviewAnnotationPayload | null) => void;
  readonly controlPosition?: "top" | "bottom";
  readonly onFirstFrame?: () => void;
  readonly onViewport?: (viewport: PreviewStreamViewport) => void;
  readonly onControl?: (control: PreviewStreamControl | null) => void;
  readonly onPopup?: (tabId: string) => void;
  readonly className?: string;
  readonly pdfUrl?: string | null;
  readonly ref?: Ref<ServerBrowserHandle>;
}

export function ServerBrowserSurface(props: ServerBrowserSurfaceProps) {
  const [connection, setConnection] = useState(0);
  const host = useDesktopBrowserHostState(props.mode === "native" ? props.runtimeTabId : undefined);
  const reconnect = useStableCallback(() => setConnection((current) => current + 1));
  return (
    <ServerBrowserSurfaceConnection
      key={host?.kind === "offscreen" ? connection : 0}
      {...props}
      onReconnect={reconnect}
    />
  );
}

function ServerBrowserSurfaceConnection(
  props: ServerBrowserSurfaceProps & { readonly onReconnect: () => void },
) {
  const {
    environmentId,
    threadId,
    tabId,
    runtimeTabId,
    visible,
    mode = "stream",
    children,
    followSize = true,
    controlPosition = "top",
    onFirstFrame,
    onViewport,
    onControl,
    onPopup,
    className,
    pdfUrl = null,
    ref,
  } = props;
  const native = mode === "native";
  const localHost = useDesktopBrowserHostState(native ? runtimeTabId : undefined);
  const offscreen = native && localHost?.kind === "offscreen";
  const nativeChildren = native && !offscreen;
  const layoutZoomFactor = useBrowserLayoutZoomFactor(props.zoomFactor ?? 1);
  const [surfaceId] = useState(randomUUID);
  const localFrameRef = useRef<LocalBrowserFrame | null>(null);
  const localFocusRef = useRef<ReturnType<typeof createLocalBrowserFocusController> | null>(null);
  const [localReady, setLocalReady] = useState(false);
  const privateEntryRef = useRef(false);
  const [privateEntry, setPrivateEntry] = useState(false);
  const nativeFocusOnlyRef = useRef(false);
  const [nativeFocusOnly, setNativeFocusOnly] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const selectionRequestRef = useRef<{ id: string; scope: string | undefined } | null>(null);
  const selectionReceived = useEffectEvent(
    (requestId: string, annotation: PreviewAnnotationPayload | null, failed = false) => {
      if (
        selectionRequestRef.current?.id !== requestId ||
        selectionRequestRef.current.scope !== props.selectionScope ||
        !props.picking ||
        controlRef.current?.controller !== "you" ||
        privateEntryRef.current
      )
        return;
      selectionRequestRef.current = null;
      if (failed)
        toastManager.add({
          type: "error",
          title: "Could not inspect the selected element",
          description: "Try selecting the element again.",
        });
      props.onSelection?.(annotation);
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancelling the picker invalidates replies from the browser stream.
  useEffect(() => {
    if (!props.picking) selectionRequestRef.current = null;
  }, [props.picking]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const keySentRef = useRef(false);
  const clientRef = useRef<PreviewStreamClient | null>(null);
  const viewportRef = useRef<PreviewStreamViewport | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const hasFrameRef = useRef(false);
  const controlRef = useRef<PreviewStreamControl | null>(null);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [gone, setGone] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [fileChooser, setFileChooser] = useState<PreviewStreamFileChooser | null>(null);
  const [agentCursor, setAgentCursor] = useState<AgentCursorPlacement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const answerFileChooser = (files: ReadonlyArray<File>) => {
    const chooser = fileChooser;
    if (!chooser) return;
    setFileChooser(null);
    void uploadPreviewStreamFiles(chooser, files).catch((cause: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not send the files to the page",
        description: cause instanceof Error ? cause.message : undefined,
      }),
    );
  };
  const unauthorizedRef = useRef(0);
  const [accessDenied, setAccessDenied] = useState(false);
  const access = usePreviewStreamAccess(environmentId, { retry: visible && !accessDenied });
  const [hostSetup, setHostSetup] = useState<PreviewStreamHostSetup | null>(null);
  const pendingMoveRef = useRef<MouseInput | null>(null);
  const pendingWheelRef = useRef<WheelInput | null>(null);
  const inputFrameRef = useRef<number | null>(null);
  const mouseButtonsRef = useRef(0);
  const mouseClicksRef = useRef({ left: 1, middle: 1, right: 1, none: 1 });
  const lastClickRef = useRef<{
    button: PreviewStreamMouseButton;
    time: number;
    x: number;
    y: number;
    count: number;
  } | null>(null);
  const touchRef = useRef<TouchGesture | null>(null);
  const probeRef = useRef<TouchProbe | null>(null);
  const lastProbeRef = useRef<{ x: number; y: number; editable: boolean; at: number } | null>(null);
  const firstFrame = useEffectEvent(() => onFirstFrame?.());
  const viewportChanged = useEffectEvent((viewport: PreviewStreamViewport) =>
    onViewport?.(viewport),
  );
  const controlChanged = useEffectEvent((next: PreviewStreamControl | null) => onControl?.(next));
  const popupOpened = useEffectEvent((popupTabId: string) => onPopup?.(popupTabId));
  const [cap, setCap] = useState<{ width: number; height: number } | null>(null);

  const probeReceived = useStableCallback((result: { x: number; y: number; editable: boolean }) => {
    if (!privateEntryRef.current && controlRef.current?.controller !== "you") return;
    lastProbeRef.current = { ...result, at: performance.now() };
    const probe = probeRef.current;
    if (!probe || probe.x !== result.x || probe.y !== result.y) return;
    probe.editable = result.editable;
    probe.answered = true;
    if (!probe.tapped) return;
    probeRef.current = null;
    if (result.editable) inputRef.current?.focus({ preventScroll: true });
    else inputRef.current?.blur();
  });
  const inputAllowed = () => {
    if (privateEntryRef.current) {
      return visible && !controlPending && localReady && localFrameRef.current !== null;
    }
    if (nativeFocusOnlyRef.current) return false;
    const current = controlRef.current;
    if (!native) return current?.controller === "you";
    return (
      visible &&
      (!offscreen || localReady) &&
      !controlPending &&
      current?.canOperate === true &&
      current.controller === "you" &&
      current.ready === true
    );
  };

  const send = (input: PreviewStreamInput) => {
    if (nativeFocusOnlyRef.current && !privateEntryRef.current) return false;
    if (
      privateEntryRef.current &&
      input.type !== "takeControl" &&
      input.type !== "releaseControl"
    ) {
      const frame = localFrameRef.current;
      if (!inputAllowed() || !frame || !previewBridge || !isLocalSurfaceInput(input)) return false;
      void previewBridge.surface
        .input({
          tabId: frame.tabId,
          surfaceId: frame.surfaceId,
          webContentsId: frame.webContentsId,
          sequence: frame.sequence,
          generation: frame.generation,
          input,
        })
        .then((result) => {
          const current = localFrameRef.current;
          if (
            !privateEntryRef.current ||
            !current ||
            current.surfaceId !== frame.surfaceId ||
            current.webContentsId !== frame.webContentsId ||
            current.generation !== frame.generation
          )
            return;
          if (input.type === "probe" && result.editable !== undefined) {
            probeReceived({ x: input.x, y: input.y, editable: result.editable });
          }
        })
        .catch(() => {
          const current = localFrameRef.current;
          if (
            !privateEntryRef.current ||
            !current ||
            current.surfaceId !== frame.surfaceId ||
            current.webContentsId !== frame.webContentsId ||
            current.generation !== frame.generation
          )
            return;
          setLocalError("Private input was refused. Take control again.");
          clearInput();
        });
      return true;
    }
    if (native && (isLocalSurfaceInput(input) || input.type === "inspect") && !inputAllowed())
      return false;
    return clientRef.current?.send(input) ?? false;
  };

  // Keep clearInput stable: a new identity reconnects the stream.
  const clearInput = useStableCallback((blur = true) => {
    if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = null;
    pendingMoveRef.current = pendingWheelRef.current = null;
    mouseButtonsRef.current = 0;
    mouseClicksRef.current = { left: 1, middle: 1, right: 1, none: 1 };
    lastClickRef.current = null;
    touchRef.current = probeRef.current = lastProbeRef.current = null;
    keySentRef.current = false;
    if (inputRef.current) inputRef.current.value = INPUT_SENTINEL;
    if (blur) inputRef.current?.blur();
  });

  const flushInput = () => {
    if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = null;
    const move = pendingMoveRef.current;
    const wheel = pendingWheelRef.current;
    pendingMoveRef.current = null;
    pendingWheelRef.current = null;
    if (move) send(move);
    if (wheel) send(wheel);
  };

  const scheduleFlush = () => {
    if (inputFrameRef.current === null) inputFrameRef.current = requestAnimationFrame(flushInput);
  };

  const queueWheel = (point: PagePoint, deltaX: number, deltaY: number, modifiers: number) => {
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = {
      type: "wheel",
      x: point.x,
      y: point.y,
      deltaX: (pending?.deltaX ?? 0) + deltaX,
      deltaY: (pending?.deltaY ?? 0) + deltaY,
      modifiers,
    };
    scheduleFlush();
  };

  const pagePoint = (clientX: number, clientY: number, clamp: boolean): PagePoint | null => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || !hasFrameRef.current || !inputAllowed()) return null;
    const rect = canvas.getBoundingClientRect();
    const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const width = canvas.width * fit;
    const height = canvas.height * fit;
    if (!(width > 0 && height > 0)) return null;
    const scale = viewport.width / width;
    const x = (clientX - rect.left - (rect.width - width) / 2) * scale;
    const y = (clientY - rect.top - (rect.height - height) / 2) * (viewport.height / height);
    const inside = x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
    if (!inside && !clamp) return null;
    return {
      x: Math.min(Math.max(x, 0), viewport.width),
      y: Math.min(Math.max(y, 0), viewport.height),
      scale,
    };
  };

  const countClick = (button: PreviewStreamMouseButton, x: number, y: number, time: number) => {
    const last = lastClickRef.current;
    const count =
      last &&
      last.button === button &&
      time - last.time < MULTI_CLICK_MS &&
      Math.hypot(x - last.x, y - last.y) < MULTI_CLICK_SLOP_PX
        ? last.count + 1
        : 1;
    lastClickRef.current = { button, time, x, y, count };
    return count;
  };

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });

  useImperativeHandle(
    ref,
    () => ({
      navigate: (url) => send({ type: "navigate", url }),
      history: (delta) => send({ type: "history", delta }),
      reload: (options) =>
        send({ type: "reload", ...(options?.ignoreCache ? { ignoreCache: true } : {}) }),
      viewport: (setting) => send({ type: "viewport", setting }),
      canvas: () =>
        !privateEntryRef.current && !pdfUrl && hasFrameRef.current ? canvasRef.current : null,
      screenshot: () => {
        const canvas = canvasRef.current;
        const viewport = viewportRef.current;
        if (privateEntryRef.current || pdfUrl || !canvas || !viewport || !hasFrameRef.current)
          return null;
        return {
          dataUrl: canvas.toDataURL("image/png"),
          width: canvas.width,
          height: canvas.height,
          cropRect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
        };
      },
    }),
    [pdfUrl, send],
  );

  const localPrivateEntryChanged = useEffectEvent((active: boolean) => {
    if (privateEntryRef.current === active) return;
    clearInput(!active);
    privateEntryRef.current = active;
    setPrivateEntry(active);
    if (active) {
      selectionRequestRef.current = null;
      props.onSelection?.(null);
      setFileChooser(null);
      setAgentCursor(null);
    }
  });
  const localFramePainted = useEffectEvent((frame: LocalBrowserFrame) => {
    localFrameRef.current = frame;
    localFocusRef.current?.report();
    const previous = viewportRef.current;
    viewportRef.current = { width: frame.width, height: frame.height };
    if (previous?.width !== frame.width || previous.height !== frame.height) {
      viewportChanged(viewportRef.current);
    }
    setLocalError(null);
    if (!hasFrameRef.current) {
      hasFrameRef.current = true;
      setLocalReady(true);
      firstFrame();
    }
  });
  const localPresentationSize = useEffectEvent((size: { width: number; height: number }) => {
    if (props.fitSourceContent && runtimeTabId) {
      const presentation = useBrowserSurfaceStore.getState().byTabId[runtimeTabId];
      const fitted = resolveFittedBrowserViewport(
        props.viewport ?? FILL_PREVIEW_VIEWPORT,
        presentation?.fittedSourceContent ?? presentation?.content ?? null,
        layoutZoomFactor,
      );
      return { width: fitted.width, height: fitted.height };
    }
    return {
      width: Math.max(1, Math.round(size.width / layoutZoomFactor)),
      height: Math.max(1, Math.round(size.height / layoutZoomFactor)),
    };
  });
  const localCanFocus = useEffectEvent(inputAllowed);
  const localPreparationChanged = useEffectEvent((active: boolean) => {
    nativeFocusOnlyRef.current = active;
    setNativeFocusOnly(active);
    if (active) clearInput(false);
  });
  const localPreparePrivateEntry = useEffectEvent(async (signal: AbortSignal) => {
    const client = clientRef.current;
    const current = controlRef.current;
    if (!client || !current) throw new Error("Browser control is unavailable.");
    await client.preparePrivateEntry(current.generation, signal);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns one local presenter and acknowledges each PNG only after rendering or dropping it
  useEffect(() => {
    const bridge = previewBridge;
    const canvas = canvasRef.current;
    if (
      !offscreen ||
      !runtimeTabId ||
      !bridge ||
      !canvas ||
      localHost?.webContentsId == null ||
      !visible
    )
      return;
    let disposed = false;
    let presentVersion = 0;
    const focus = createLocalBrowserFocusController({
      canvas,
      keyboardInput: () => inputRef.current,
      frame: () => localFrameRef.current,
      canFocus: localCanFocus,
      preparePrivateEntry: localPreparePrivateEntry,
      onPreparationChange: localPreparationChanged,
      bridge: bridge.surface,
      tabId: runtimeTabId,
      surfaceId,
      webContentsId: localHost.webContentsId,
    });
    localFocusRef.current = focus;
    const receiver = createLocalBrowserFrameReceiver({
      canvas,
      bridge: bridge.surface,
      tabId: runtimeTabId,
      surfaceId,
      webContentsId: localHost.webContentsId,
      onPrivateEntry: localPrivateEntryChanged,
      onPainted: localFramePainted,
      onError: () => setLocalError("Could not display the browser frame."),
    });
    const unsubscribe = bridge.surface.onFrame((frame) => {
      void receiver.receive(frame);
    });
    const present = () => {
      const size = canvas.parentElement?.getBoundingClientRect();
      presentVersion = presentVersion + 1;
      const version = presentVersion;
      void bridge.surface
        .present({
          tabId: runtimeTabId,
          surfaceId,
          visible: true,
          ...(size && size.width >= 1 && size.height >= 1 ? localPresentationSize(size) : {}),
        })
        .then((state) => {
          if (disposed || version !== presentVersion) return;
          if (state.privateEntry) localPrivateEntryChanged(true);
        })
        .catch(() => {
          if (!disposed && version === presentVersion)
            setLocalError("Could not connect the browser surface.");
        });
    };
    present();
    const stopObserving = observeResize(canvas.parentElement ?? canvas, present);
    window.addEventListener("resize", present);
    return () => {
      disposed = true;
      focus.stop();
      if (localFocusRef.current === focus) localFocusRef.current = null;
      receiver.stop();
      unsubscribe();
      stopObserving();
      window.removeEventListener("resize", present);
      void bridge.surface
        .present({ tabId: runtimeTabId, surfaceId, visible: false })
        .catch(() => undefined);
      localFrameRef.current = null;
      setLocalReady(false);
      privateEntryRef.current = false;
      setPrivateEntry(false);
      hasFrameRef.current = false;
      viewportRef.current = null;
      canvas.width = canvas.height = 0;
      selectionRequestRef.current = null;
      clearInput();
    };
  }, [offscreen, runtimeTabId, localHost?.webContentsId, surfaceId, visible, clearInput]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the canvas container's size, sends resizes to the stream and grows the frame cap
  useEffect(() => {
    if (native) return;
    const element = canvasRef.current?.parentElement;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const growCap = () => {
      capTimer = null;
      const size = sizeRef.current;
      if (!size) return;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(size.width * ratio);
      const height = Math.round(size.height * ratio);
      setCap((current) =>
        current !== null && current.width >= width && current.height >= height
          ? current
          : {
              width: Math.max(width, current?.width ?? 0),
              height: Math.max(height, current?.height ?? 0),
            },
      );
    };
    const measure = () => {
      timer = null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      const previous = sizeRef.current;
      if (previous?.width === size.width && previous.height === size.height) return;
      sizeRef.current = size;
      if (followSize) clientRef.current?.send({ type: "resize", ...size });
      // Growing the cap reconnects the stream; wait until resizing settles.
      if (capTimer !== null) clearTimeout(capTimer);
      capTimer = setTimeout(growCap, previous === null ? 0 : RESIZE_THROTTLE_MS * 2);
    };
    const stopObserving = observeResize(element, () => {
      if (timer !== null) return;
      timer = setTimeout(measure, sizeRef.current === null ? 0 : RESIZE_THROTTLE_MS);
    });
    return () => {
      stopObserving();
      if (timer !== null) clearTimeout(timer);
      if (capTimer !== null) clearTimeout(capTimer);
    };
  }, [followSize, native]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects visible browser controls and paints streamed surfaces
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || accessDenied || hostSetup || gone || !access || (!native && (!cap || !canvas)))
      return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const painter =
      !native && canvas
        ? createPreviewFramePainter(canvas, () => {
            if (hasFrameRef.current) return;
            hasFrameRef.current = true;
            firstFrame();
          })
        : null;
    const client = createPreviewStreamClient(
      {
        access,
        threadId,
        tabId,
        maxWidth: cap?.width ?? 1,
        maxHeight: cap?.height ?? 1,
        ...(native ? { frames: false } : {}),
      },
      {
        onFrame: (jpeg) => {
          if (native) return;
          unauthorizedRef.current = 0;
          painter?.paint(jpeg);
        },
        onSelection: selectionReceived,
        onProbe: (result) => {
          if (!privateEntryRef.current) probeReceived(result);
        },
        onPointer: (pointer) => {
          const placed = placeAgentCursor(pointer, canvasRef.current, viewportRef.current);
          if (placed) setAgentCursor(placed);
        },
        onClipboard: (text) => {
          if (!privateEntryRef.current) void copyPageText(text);
        },
        onDownload: (download) => {
          if (!privateEntryRef.current) offerDownload(download);
        },
        onPopup: popupOpened,
        onFileChooser: (chooser) => {
          if (!privateEntryRef.current) setFileChooser(chooser);
        },
        onViewport: (viewport) => {
          if (native) return;
          viewportRef.current = viewport;
          viewportChanged(viewport);
        },
        onControl: (next) => {
          unauthorizedRef.current = 0;
          setControlPending(native && next.controller === "you" && next.ready === false);
          const previous = controlRef.current;
          controlRef.current = next;
          setControl(next);
          controlChanged(next);
          if (
            next.dialog?.message !== previous?.dialog?.message ||
            next.dialog?.defaultValue !== previous?.dialog?.defaultValue
          )
            setPromptText(next.dialog?.defaultValue ?? "");
          if (next.controller !== "you") {
            clearInput(!nativeFocusOnlyRef.current);
          } else if (previous?.controller !== "you") {
            const size = sizeRef.current;
            if (!native && followSize && size) client.send({ type: "resize", ...size });
          }
        },
        onConnectedChange: (connected) => {
          setReconnecting(!connected);
          if (connected) return;
          localFocusRef.current?.connectionLost();
          setControlPending(false);
          setFileChooser(null);
          controlRef.current = null;
          setControl(null);
          controlChanged(null);
          clearInput(!nativeFocusOnlyRef.current && !privateEntryRef.current);
        },
        onHostSetup: setHostSetup,
        ...(native ? { onGone: () => setGone(true) } : {}),
        onUnauthorized: () => {
          const refusals = ++unauthorizedRef.current;
          if (refusals >= MAX_UNAUTHORIZED_REFUSALS) {
            inputRef.current?.blur();
            setAccessDenied(true);
            return;
          }
          refreshTimer = setTimeout(
            () => refreshPreviewStreamAccess(environmentId),
            refusals === 1 ? 0 : 1_000 * 2 ** (refusals - 1),
          );
        },
      },
    );
    clientRef.current = client;
    return () => {
      painter?.stop();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      selectionRequestRef.current = null;
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
      controlRef.current = null;
      setControl(null);
      setControlPending(false);
      controlChanged(null);
      clearInput();
    };
  }, [
    access,
    accessDenied,
    cap,
    clearInput,
    environmentId,
    followSize,
    gone,
    hostSetup,
    native,
    probeReceived,
    tabId,
    threadId,
    visible,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers a non-passive wheel listener on the canvas so it can stop the panel scrolling
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Registered natively: React's wheel listener is passive and cannot stop the panel scrolling.
    const onWheel = (event: WheelEvent) => {
      const point = pagePoint(event.clientX, event.clientY, false);
      if (!point) return;
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? WHEEL_LINE_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? (viewportRef.current?.height ?? 0)
            : 1;
      queueWheel(point, event.deltaX * unit, event.deltaY * unit, previewStreamModifiers(event));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [pagePoint, queueWheel]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pending input animation frame when the component unmounts
  useEffect(
    () => () => {
      if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
    },
    [],
  );

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!inputAllowed()) return;
    // Thumb buttons drive this tab's history in handleMouseUp, never the page.
    if (historyDeltaOf(event.button) !== null) return;
    const { type, pointerId, clientX, clientY } = event;
    if (props.picking && !privateEntryRef.current) {
      event.preventDefault();
      event.stopPropagation();
      if (type === "pointerdown" && event.button === 0) {
        const point = pagePoint(clientX, clientY, false);
        if (point) {
          const requestId = randomUUID();
          selectionRequestRef.current = { id: requestId, scope: props.selectionScope };
          send({ type: "inspect", requestId, x: point.x, y: point.y });
        }
      }
      return;
    }
    const cancelled = type === "pointercancel";
    const touch = touchRef.current;
    if (cancelled && touch?.pointerId === pointerId) {
      touchRef.current = probeRef.current = null;
      return;
    }
    if (event.pointerType === "touch" && !cancelled) {
      const point = pagePoint(clientX, clientY, type === "pointermove");
      if (type === "pointerdown") {
        if (!event.isPrimary) return;
        touchRef.current = {
          pointerId,
          startX: clientX,
          startY: clientY,
          lastX: clientX,
          lastY: clientY,
          panning: false,
        };
        const last = lastProbeRef.current;
        const reusable =
          point &&
          last &&
          performance.now() - last.at < PROBE_REUSE_MS &&
          Math.hypot(point.x - last.x, point.y - last.y) < PROBE_REUSE_PX;
        probeRef.current = point
          ? {
              x: point.x,
              y: point.y,
              editable: reusable ? last.editable : null,
              answered: false,
              tapped: false,
            }
          : null;
        if (point) send({ type: "probe", x: point.x, y: point.y });
        return;
      }
      if (!touch || touch.pointerId !== pointerId) return;
      if (type === "pointermove") {
        if (
          !touch.panning &&
          Math.hypot(clientX - touch.startX, clientY - touch.startY) < TAP_SLOP_PX
        )
          return;
        touch.panning = true;
        if (point)
          queueWheel(
            point,
            (touch.lastX - clientX) * point.scale,
            (touch.lastY - clientY) * point.scale,
            0,
          );
        touch.lastX = clientX;
        touch.lastY = clientY;
        return;
      }
      touchRef.current = null;
      const probe = probeRef.current;
      if (touch.panning) {
        probeRef.current = null;
        return;
      }
      if (!point) return;
      // iOS requires focus during the tap; late probe replies only raise Android's keyboard.
      if (probe?.editable === true) focusInput();
      else if (probe?.editable === false) inputRef.current?.blur();
      if (probe && !probe.answered) probe.tapped = true;
      else probeRef.current = null;
      flushInput();
      const clickCount = countClick("left", clientX, clientY, event.timeStamp);
      const at = { x: point.x, y: point.y, modifiers: 0 };
      send({ type: "mouse", action: "move", ...at, button: "none", buttons: 0, clickCount: 0 });
      send({ type: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount });
      send({ type: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount });
      return;
    }
    const previous = mouseButtonsRef.current;
    if ((cancelled || type === "pointerup") && previous === 0) return;
    if (cancelled || type === "pointerup")
      mouseButtonsRef.current = cancelled ? 0 : event.buttons & 7;
    const point = pagePoint(
      clientX,
      clientY,
      type !== "pointerdown" &&
        (cancelled || type === "pointerup" || previous !== 0 || event.buttons !== 0),
    );
    if (!point) return;
    const at = { x: point.x, y: point.y, modifiers: previewStreamModifiers(event) };
    const mouse = (action: "down" | "up", button: PreviewStreamMouseButton, buttons: number) => {
      if (action === "down")
        mouseClicksRef.current[button] = countClick(button, clientX, clientY, event.timeStamp);
      send({
        type: "mouse",
        action,
        ...at,
        button,
        buttons,
        clickCount: mouseClicksRef.current[button],
      });
    };
    if (type === "pointerdown") {
      focusInput();
      event.currentTarget.setPointerCapture(pointerId);
      flushInput();
      mouseButtonsRef.current = event.buttons & 7;
      mouse("down", buttonOf(event.button), event.buttons);
    } else if (type === "pointerup") {
      flushInput();
      mouse("up", buttonOf(event.button), event.buttons);
    } else {
      // Chords arrive as pointermove. Cancellation releases every held button.
      const next = cancelled ? 0 : event.buttons & 7;
      const changed = previous ^ next;
      if (previous !== 0 && changed !== 0) {
        flushInput();
        let buttons = previous;
        for (const bit of [1, 2, 4]) {
          if (!(changed & bit)) continue;
          buttons ^= bit;
          mouse(next & bit ? "down" : "up", pressedButtonOf(bit), buttons);
        }
        mouseButtonsRef.current = next;
      }
      if (cancelled) return;
      pendingMoveRef.current = {
        type: "mouse",
        action: "move",
        ...at,
        button: pressedButtonOf(event.buttons),
        buttons: event.buttons,
        clickCount: 0,
      };
      scheduleFlush();
    }
  };

  // Chromium runs a thumb button's back/forward on mouseup in this document, which
  // would move the app's router. Cancel it and send the press to the preview, as
  // the toolbar does.
  const handleMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    const delta = historyDeltaOf(event.button);
    if (delta === null) return;
    event.preventDefault();
    send({ type: "history", delta });
  };

  const resetInput = (textarea: HTMLTextAreaElement) => {
    keySentRef.current = false;
    textarea.value = INPUT_SENTINEL;
    textarea.setSelectionRange(INPUT_SENTINEL.length, INPUT_SENTINEL.length);
  };

  const sendKeyPress = (
    key: typeof BACKSPACE | typeof DELETE | typeof COPY | typeof CUT,
    modifiers = 0,
  ) => {
    send({ type: "key", action: "down", ...key, modifiers });
    send({ type: "key", action: "up", ...key, modifiers });
  };

  // Edit menu Copy and Cut fire no key, so send the shortcut the server copies on.
  const handleClipboard = (key: typeof COPY | typeof CUT, event: ClipboardEvent) => {
    // Keep the sentinel off the clipboard.
    event.preventDefault();
    if (!inputAllowed()) return;
    sendKeyPress(key, CTRL);
  };

  const handleKey = (action: "down" | "up", event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (action === "down") event.currentTarget.blur();
      return;
    }
    if (!inputAllowed()) return;
    keySentRef.current = false;
    if (
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Unidentified"
    ) {
      return;
    }
    const shortcut = event.ctrlKey || event.metaKey;
    if (shortcut && event.key.toLowerCase() === "v") return;
    if (event.shiftKey && event.key === "Insert") return;
    // Enter carries "\r" like Puppeteer's key table, so forms submit and textareas break lines.
    const text = shortcut
      ? undefined
      : [...event.key].length === 1
        ? event.key
        : event.key === "Enter"
          ? "\r"
          : undefined;
    send({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ...(action === "down" && text !== undefined ? { text } : {}),
      modifiers: previewStreamModifiers(event),
    });
    // Some Android keyboards edit the textarea even when keydown is prevented.
    keySentRef.current =
      action === "down" &&
      !shortcut &&
      (text !== undefined || event.key === "Backspace" || event.key === "Delete");
    // The key copies or cuts in the page, so stop the browser's own copy or cut repeating it.
    if (
      event.ctrlKey !== event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      ["c", "x"].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
    }
    if (shortcut) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent;
    if (nativeEvent instanceof InputEvent && nativeEvent.isComposing) return;
    const textarea = event.currentTarget;
    const inputType = nativeEvent instanceof InputEvent ? nativeEvent.inputType : "";
    if (keySentRef.current) keySentRef.current = false;
    else if (inputType === "deleteContentBackward") sendKeyPress(BACKSPACE);
    else if (inputType === "deleteContentForward") sendKeyPress(DELETE);
    else {
      const text = textarea.value.replace(/^\u200b/, "");
      if (text) send({ type: "text", text });
    }
    resetInput(textarea);
  };

  const nativeControlReady =
    visible &&
    !controlPending &&
    control?.canOperate === true &&
    control.controller === "you" &&
    control.ready === true;
  const renderedInputAllowed = privateEntry
    ? visible && !controlPending && localReady
    : nativeFocusOnly
      ? false
      : native
        ? nativeControlReady && (!offscreen || localReady)
        : control?.controller === "you";
  const nativeControlUnsupported = native && control !== null && typeof control.ready !== "boolean";
  let controlLabel = previewStreamControlLabel(control);
  if (native) {
    if (accessDenied) controlLabel = "Browser connection was refused.";
    else if (hostSetup) controlLabel = previewStreamHostSetupMessage(hostSetup);
    else if (gone) controlLabel = "Browser tab is no longer available.";
    else if (reconnecting) controlLabel = "Reconnecting…";
    else if (nativeControlUnsupported) controlLabel = "Update the server to use native control.";
    else if (control?.canOperate && control.controller === "you" && !control.ready)
      controlLabel = "Control reserved…";
    else if (controlPending && control?.controller === "you") controlLabel = "Releasing control…";
  }

  if (offscreen && privateEntry) controlLabel = "Private entry";
  else if (nativeFocusOnly) controlLabel = "Preparing private entry…";
  if (offscreen && localError) controlLabel = localError;

  const page = (
    <>
      {pdfUrl ? (
        <embed
          src={pdfUrl}
          type="application/pdf"
          title="PDF document"
          className="absolute inset-0 z-10 size-full border-0"
        />
      ) : null}
      <canvas
        ref={canvasRef}
        className={cn(
          "block size-full touch-none object-contain",
          props.picking && !privateEntry && "cursor-crosshair",
        )}
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
        onPointerUp={handlePointer}
        onPointerCancel={handlePointer}
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      />
      {!privateEntry && !pdfUrl && agentCursor && control?.controller !== "you" ? (
        <AgentCursorMark
          {...agentCursor}
          controller={control?.controller === "agent" ? "agent" : "none"}
        />
      ) : null}
      {/* Pin top-left to avoid focus scrolling; 16px prevents iOS focus zoom. */}
      <textarea
        ref={inputRef}
        aria-label="Browser page"
        aria-description="Press Shift+Escape to leave the browser page."
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={pdfUrl !== null || (!renderedInputAllowed && !nativeFocusOnly)}
        readOnly={nativeFocusOnly && !privateEntry}
        defaultValue={INPUT_SENTINEL}
        onFocus={(event) => resetInput(event.currentTarget)}
        className="sr-only top-0 left-0 text-base"
        onKeyDown={(event) => handleKey("down", event)}
        onKeyUp={(event) => handleKey("up", event)}
        onInput={handleInput}
        onCompositionEnd={(event) => {
          const text = event.data.replace(/^\u200b/, "");
          if (text) send({ type: "text", text });
          resetInput(event.currentTarget);
        }}
        onCopy={(event) => handleClipboard(COPY, event)}
        onCut={(event) => handleClipboard(CUT, event)}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (text) send({ type: "text", text });
        }}
      />
    </>
  );

  return (
    <div
      className={cn("relative flex flex-col overflow-hidden", className)}
      data-server-browser-surface={tabId}
      onMouseUp={nativeChildren ? undefined : handleMouseUp}
    >
      <div
        className={cn(
          "visible relative z-20 flex shrink-0 items-center justify-between gap-2 border-border bg-background px-2 py-1",
          controlPosition === "bottom" ? "order-last border-t" : "border-b",
        )}
      >
        <span role="status" className="min-w-0 truncate text-xs text-muted-foreground">
          {controlLabel}
        </span>
        {native && (accessDenied || hostSetup || gone || (localError !== null && !privateEntry)) ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              unauthorizedRef.current = 0;
              setAccessDenied(false);
              setHostSetup(null);
              setGone(false);
              setLocalError(null);
              if (runtimeTabId) reconnectDesktopBrowserHost(runtimeTabId);
              refreshPreviewStreamAccess(environmentId);
              props.onReconnect();
            }}
          >
            Reconnect
          </Button>
        ) : native || control?.canOperate ? (
          <Button
            variant="outline"
            size="xs"
            disabled={
              !control?.canOperate ||
              control.controller === "another-viewer" ||
              controlPending ||
              nativeFocusOnly ||
              nativeControlUnsupported
            }
            aria-busy={controlPending}
            onClick={() => {
              if (
                send({ type: control?.controller === "you" ? "releaseControl" : "takeControl" }) &&
                native
              )
                setControlPending(true);
            }}
          >
            {control?.controller === "you" ? "Release control" : "Take control"}
          </Button>
        ) : null}
      </div>
      <div className={cn("relative min-h-0 flex-1", native && "flex flex-col")}>
        {nativeChildren ? (
          <div className="relative min-h-0 flex-1">
            {typeof children === "function" ? children(nativeControlReady) : children}
          </div>
        ) : offscreen && runtimeTabId ? (
          <OffscreenBrowserViewport
            threadRef={{ environmentId, threadId: ThreadId.make(threadId) }}
            tabId={tabId}
            runtimeTabId={runtimeTabId}
            viewport={props.viewport ?? FILL_PREVIEW_VIEWPORT}
            zoomFactor={props.zoomFactor ?? 1}
            visible={visible}
            interactive={renderedInputAllowed}
            focusOnly={nativeFocusOnly}
            fitSourceContent={props.fitSourceContent ?? false}
          >
            {page}
          </OffscreenBrowserViewport>
        ) : (
          page
        )}
        {fileChooser && control?.controller === "you" ? (
          <div
            className={cn(
              "z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg",
              native ? "relative m-2 shrink-0" : "absolute inset-x-2 top-2",
            )}
            role="dialog"
            aria-label="Choose files for the page"
          >
            <p className="text-sm">
              The page asks for {fileChooser.multiple ? "files" : "a file"}.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple={fileChooser.multiple}
              accept={fileChooser.accept}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                if (files.length > 0) answerFileChooser(files);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => answerFileChooser([])}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                Choose {fileChooser.multiple ? "files" : "file"}
              </Button>
            </div>
          </div>
        ) : null}
        {control?.dialog ? (
          <div
            className={cn(
              "z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg",
              native ? "relative m-2 shrink-0" : "absolute inset-x-2 top-2",
            )}
            role="dialog"
            aria-label="Browser dialog"
          >
            <p className="break-words text-sm">{control.dialog.message}</p>
            {control.controller === "you" ? (
              <>
                {control.dialog.type === "prompt" ? (
                  <Input
                    aria-label="Dialog response"
                    value={promptText}
                    onChange={(event) => setPromptText(event.target.value)}
                  />
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => send({ type: "dialog", accept: false })}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      send({
                        type: "dialog",
                        accept: true,
                        ...(control.dialog?.type === "prompt" ? { promptText } : {}),
                      })
                    }
                  >
                    Accept
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Take control to respond.</p>
            )}
          </div>
        ) : null}
      </div>
      {visible && hostSetup && !native ? (
        <div className="visible absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background p-4 text-center">
          <p role="alert" className="max-w-sm text-sm text-muted-foreground">
            {previewStreamHostSetupMessage(hostSetup)}
          </p>
          <CommandBlock command={hostSetup.command} className="w-full max-w-md text-left" />
          <Button variant="outline" size="sm" onClick={() => setHostSetup(null)}>
            Try again
          </Button>
        </div>
      ) : null}
      {visible && accessDenied && !native ? (
        // The page can be invisible beneath an empty or unreachable state; reconnect must remain reachable.
        <div className="visible absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background p-3 text-center">
          <p role="alert" className="text-xs text-muted-foreground">
            Browser connection was refused.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              unauthorizedRef.current = 0;
              setAccessDenied(false);
              refreshPreviewStreamAccess(environmentId);
            }}
          >
            Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface AgentCursorPlacement {
  readonly phase: PreviewStreamPointer["phase"];
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
}

function placeAgentCursor(
  pointer: PreviewStreamPointer,
  canvas: HTMLCanvasElement | null,
  viewport: PreviewStreamViewport | null,
): AgentCursorPlacement | null {
  if (!canvas || !viewport || canvas.width < 1 || canvas.height < 1) return null;
  const box = { width: canvas.clientWidth, height: canvas.clientHeight };
  const fit = Math.min(box.width / canvas.width, box.height / canvas.height);
  const width = canvas.width * fit;
  const height = canvas.height * fit;
  return {
    phase: pointer.phase,
    sequence: pointer.sequence,
    left: (box.width - width) / 2 + (pointer.x * width) / viewport.width,
    top: (box.height - height) / 2 + (pointer.y * height) / viewport.height,
  };
}
