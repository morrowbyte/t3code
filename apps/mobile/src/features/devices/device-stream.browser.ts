import { createCanvasFrameSink } from "@t3tools/client-runtime/device/frame";
import { createPhoneViewer, type PhoneViewer } from "@t3tools/client-runtime/device/phone-viewer";
import {
  createPhoneInteraction,
  phoneWheelNavigation,
} from "@t3tools/client-runtime/device/phone-interaction";
import {
  GALAXY_S24_ULTRA_SHAPE,
  resolveDeviceShape,
} from "@t3tools/client-runtime/device/shape-profile";
import {
  createDeviceStreamClient,
  type DeviceScreenSize,
} from "@t3tools/client-runtime/device/stream";

import type { DeviceStreamConfiguration } from "./device-stream-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

let activeClient: ReturnType<typeof createDeviceStreamClient> | null = null;

let disposePresentation: (() => void) | null = null;

export function stop() {
  disposePresentation?.();
  disposePresentation = null;
  activeClient?.stop();
  activeClient = null;
}

export function command(button: "home" | "back" | "appSwitcher" | "rotate") {
  if (button === "rotate") activeClient?.rotate();
  else activeClient?.pressButton(button);
}

export function start(configuration: DeviceStreamConfiguration) {
  stop();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
  const post = (message: object) => window.ReactNativeWebView.postMessage(JSON.stringify(message));
  const { colors, platform } = configuration;
  Object.assign(document.documentElement.style, { height: "100%", overflow: "hidden" });
  Object.assign(document.body.style, {
    margin: "0",
    height: "100%",
    overflow: "hidden",
    background: colors.background,
    color: colors.foreground,
    fontFamily: "system-ui",
  });
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    containerType: "size",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  const frame = document.createElement("div");
  frame.setAttribute("role", "application");
  frame.setAttribute(
    "aria-label",
    platform === "ios" ? "iOS Simulator screen" : "Android Emulator screen",
  );
  frame.tabIndex = 0;
  Object.assign(frame.style, {
    position: "relative",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
    webkitTouchCallout: "none",
    outline: "none",
  });
  const canvas = document.createElement("canvas");
  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  image.style.display = "none";
  const inputStatus = document.createElement("div");
  inputStatus.setAttribute("role", "status");
  inputStatus.textContent = "Reconnecting device controls...";
  Object.assign(inputStatus.style, {
    position: "fixed",
    bottom: "12px",
    left: "0",
    right: "0",
    textAlign: "center",
    pointerEvents: "none",
    fontSize: "13px",
    color: colors.muted,
    background: colors.background,
  });
  frame.append(canvas, image);
  container.append(frame);
  document.body.replaceChildren(container, inputStatus);

  const sceneCanvas = document.createElement("canvas");
  sceneCanvas.setAttribute("aria-label", "Interactive 3D device");
  Object.assign(sceneCanvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    touchAction: "none",
    display: "none",
  });
  container.append(sceneCanvas);
  let viewer: PhoneViewer | null = null;
  let interaction: ReturnType<typeof createPhoneInteraction> | null = null;
  let currentScreen: DeviceScreenSize | null = null;
  let flat = false;
  let forcedS24 = false;
  let mjpeg = false;
  let unavailable = false;
  const profile = () =>
    forcedS24
      ? GALAXY_S24_ULTRA_SHAPE
      : resolveDeviceShape({
          platform,
          name: configuration.deviceName ?? configuration.deviceId,
          portraitAspect:
            Math.min(canvas.width, canvas.height) / Math.max(canvas.width, canvas.height),
        });
  const controls = document.createElement("div");
  Object.assign(controls.style, {
    position: "fixed",
    bottom: "12px",
    right: "12px",
    display: "flex",
    gap: "6px",
    flexWrap: "wrap",
    maxWidth: "calc(100% - 24px)",
    zIndex: "1",
  });
  const mode = document.createElement("button");
  mode.textContent = "Flat";
  const reset = document.createElement("button");
  reset.textContent = "Reset view";
  const preset = document.createElement("select");
  preset.setAttribute("aria-label", "Device frame");
  for (const [value, label] of [
    ["auto", "Automatic frame"],
    ["s24", "Galaxy S24 Ultra"],
  ]) {
    const option = document.createElement("option");
    option.value = value!;
    option.textContent = label!;
    preset.append(option);
  }
  for (const control of [preset, mode, reset]) {
    Object.assign(control.style, {
      background: colors.buttonBackground,
      color: colors.buttonForeground,
      border: `1px solid ${colors.buttonBorder}`,
      borderRadius: "8px",
      padding: "8px",
      font: "inherit",
      fontSize: "13px",
    });
  }
  if (platform === "android") controls.append(preset);
  controls.append(mode, reset);
  if (platform === "android") document.body.append(controls);
  const resize = () => {
    const rect = container.getBoundingClientRect();
    viewer?.resize(rect.width, rect.height, window.devicePixelRatio);
  };
  const updatePresentation = () => {
    const three = platform === "android" && !flat && !mjpeg && !unavailable;
    sceneCanvas.style.display = three ? "block" : "none";
    frame.style.visibility = three ? "hidden" : "visible";
    mode.textContent = unavailable
      ? "3D unavailable"
      : mjpeg
        ? "3D requires H.264"
        : three
          ? "Flat"
          : "3D";
    mode.disabled = mjpeg || unavailable;
    reset.disabled = !three;
    if (!three || !canvas.width || !canvas.height) return;
    if (!viewer) {
      try {
        viewer = createPhoneViewer({
          canvas: sceneCanvas,
          source: canvas,
          profile: profile(),
          onUnavailable: () => {
            unavailable = true;
            updatePresentation();
          },
        });
        interaction = createPhoneInteraction({
          screenPoint: (point, captured) => viewer?.screenPoint(point.x, point.y, captured) ?? null,
          touch: (phase, point) => client.sendTouch(phase, point.x, point.y),
          orbit: (x, y) => viewer?.orbit(x, y),
          zoomBy: (delta) => viewer?.zoomBy(delta),
          onInteractionActive: (active, kind) => viewer?.setInteractionActive(active, kind),
        });
        resize();
      } catch {
        unavailable = true;
        updatePresentation();
        return;
      }
    }
    viewer.setScreen(currentScreen, profile());
    viewer.frameUpdated();
  };
  mode.addEventListener("click", () => {
    interaction?.end();
    flat = !flat;
    updatePresentation();
  });
  reset.addEventListener("click", () => {
    interaction?.end();
    viewer?.resetPose();
  });
  preset.addEventListener("change", () => {
    interaction?.end();
    forcedS24 = preset.value === "s24";
    updatePresentation();
  });
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  const point = (event: PointerEvent) => {
    const rect = sceneCanvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  sceneCanvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !inputConnected) return;
    event.preventDefault();
    sceneCanvas.setPointerCapture(event.pointerId);
    frame.focus();
    pointers.set(event.pointerId, point(event));
    if (pointers.size === 1) interaction?.begin(event.pointerId, point(event), event.altKey);
    else {
      interaction?.end();
      pinchDistance = 0;
    }
  });
  sceneCanvas.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const previous = pointers.get(event.pointerId)!;
    const next = point(event);
    pointers.set(event.pointerId, next);
    if (pointers.size < 2) {
      interaction?.move(event.pointerId, next);
      return;
    }
    const [first, second] = [...pointers.values()];
    const distance = Math.hypot(first!.x - second!.x, first!.y - second!.y);
    if (pinchDistance > 0 && distance > 0) viewer?.zoomBy(Math.log(distance / pinchDistance));
    pinchDistance = distance;
    viewer?.orbit((next.x - previous.x) / 2, (next.y - previous.y) / 2);
  });
  const endPointer = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    interaction?.end(event.pointerId);
    pinchDistance = 0;
  };
  sceneCanvas.addEventListener("pointerup", endPointer);
  sceneCanvas.addEventListener("pointercancel", endPointer);
  sceneCanvas.addEventListener("lostpointercapture", endPointer);
  sceneCanvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = sceneCanvas.getBoundingClientRect();
      const navigation = phoneWheelNavigation({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        width: rect.width,
        height: rect.height,
      });
      if (navigation) interaction?.navigate(navigation);
    },
    { passive: false },
  );
  const blur = () => {
    pointers.clear();
    interaction?.end();
    client.releaseKeys();
  };
  window.addEventListener("blur", blur);
  disposePresentation = () => {
    blur();
    observer.disconnect();
    viewer?.dispose();
    viewer = null;
    window.removeEventListener("blur", blur);
  };
  let pointerId: number | null = null;
  let inputConnected = false;
  let streaming = false;
  const reportStatus = (status: "connecting" | "streaming" | "error", detail?: string) => {
    if (activeClient !== client) return;
    streaming = status === "streaming";
    inputStatus.style.display = streaming && !inputConnected ? "block" : "none";
    post({ type: "status", status, detail });
  };
  const layout = (screen: DeviceScreenSize | null) => {
    interaction?.end();
    currentScreen = screen;
    viewer?.setScreen(screen, profile());
    const landscape =
      screen?.orientation === "landscape_left" || screen?.orientation === "landscape_right";
    const aspect = screen
      ? landscape
        ? Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height)
        : Math.min(screen.width, screen.height) / Math.max(screen.width, screen.height)
      : 9 / 19.5;
    const rotation =
      platform === "ios" && screen && screen.width <= screen.height
        ? screen.orientation === "landscape_left"
          ? 90
          : screen.orientation === "landscape_right"
            ? -90
            : screen.orientation === "portrait_upside_down"
              ? 180
              : 0
        : 0;
    const sideways = Math.abs(rotation) === 90;
    frame.style.width = `min(100cqw, ${aspect * 100}cqh)`;
    frame.style.height = `min(100cqh, ${100 / aspect}cqw)`;
    for (const media of [canvas, image]) {
      Object.assign(media.style, {
        position: "absolute",
        width: sideways ? `${100 / aspect}%` : "100%",
        height: sideways ? `${100 * aspect}%` : "100%",
        left: "50%",
        top: "50%",
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        pointerEvents: "none",
      });
    }
  };
  layout(null);
  const unauthorized = () => {
    if (activeClient === client) post({ type: "unauthorized" });
  };
  const client = createDeviceStreamClient(
    { ...configuration, preferMjpeg: platform === "ios" },
    createCanvasFrameSink(canvas, updatePresentation),
    {
      onStatus: reportStatus,
      onScreen: layout,
      onMjpegFallback: () => {
        mjpeg = true;
        updatePresentation();
        canvas.style.display = "none";
        image.style.display = "block";
      },
      onCanvasVideo: () => {
        mjpeg = false;
        updatePresentation();
        image.style.display = "none";
        canvas.style.display = "";
      },
      onUnauthorized: unauthorized,
      onInputConnected: (connected) => {
        inputConnected = connected;
        if (!connected) interaction?.end();
        inputStatus.style.display = streaming && !connected ? "block" : "none";
        post({ type: "input", connected });
      },
    },
  );
  activeClient = client;
  client.setMjpegImage(image);
  const touch = (event: PointerEvent, phase: "begin" | "move" | "end") => {
    const rect = frame.getBoundingClientRect();
    client.sendTouch(
      phase,
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    );
  };
  frame.addEventListener("pointerdown", (event) => {
    if (!inputConnected || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    frame.setPointerCapture(event.pointerId);
    frame.focus();
    touch(event, "begin");
  });
  frame.addEventListener("pointermove", (event) => {
    if (pointerId === event.pointerId) touch(event, "move");
  });
  const endTouch = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    touch(event, "end");
  };
  frame.addEventListener("pointerup", endTouch);
  frame.addEventListener("pointercancel", endTouch);
  frame.addEventListener("lostpointercapture", endTouch);
  frame.addEventListener("keydown", (event) => {
    event.preventDefault();
    client.sendKey(event, "down");
  });
  frame.addEventListener("keyup", (event) => client.sendKey(event, "up"));
  window.addEventListener("pagehide", stop, { once: true });
  post({ type: "input", connected: false });
  client.start();
}
