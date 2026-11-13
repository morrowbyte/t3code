import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopPreviewColorScheme,
  DesktopPreviewSurfaceState,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { toastManager } from "~/components/ui/toast";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn, isMacPlatform } from "~/lib/utils";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { useActiveBrowserRecordingTabIds } from "./browserRecording";
import {
  browserViewportSettingKey,
  resolveBrowserViewportLayout,
  resolveFittedBrowserViewport,
} from "./browserViewportLayout";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { acquireDesktopTab, withDesktopTab } from "./desktopTabLifetime";
import {
  acquireDesktopBrowserHostState,
  useDesktopBrowserHostedEnvironmentIds,
  useDesktopBrowserHostRevision,
  useDesktopBrowserHostState,
} from "./desktopBrowserSurface";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import { usePreviewWebviewConfig } from "./previewWebviewConfigState";
import { useBrowserLayoutZoomFactor } from "./useBrowserLayoutZoomFactor";
import { useBrowserViewportResize } from "./useBrowserViewportResize";
import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  type WebviewCrashRecoveryState,
} from "./webviewCrashRecovery";

interface ElectronWebview extends HTMLElement {
  src: string;
  partition: string;
  preload?: string;
  webpreferences?: string;
  getWebContentsId: () => number;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebview;
  }
}

function OffscreenHostConnection(props: {
  readonly enabled: boolean;
  readonly tabId: string;
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly profileId: string | undefined;
  readonly ready: Promise<void> | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly presetId: Extract<PreviewViewportSetting, { _tag: "preset" }>["presetId"] | null;
  readonly onConnected: (state: DesktopPreviewSurfaceState) => void;
}) {
  const { enabled, tabId, environmentId, profileId, ready, width, height, presetId, onConnected } =
    props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects the current tab lease to its main-owned host and applies logical viewport changes
  useEffect(() => {
    const bridge = previewBridge;
    if (!enabled || !ready || !bridge) return;
    let disposed = false;
    void (async () => {
      try {
        await ready;
        if (disposed) return;
        const state = await bridge.ensureOffscreenHost({
          tabId,
          environmentId,
          ...(profileId === undefined ? {} : { profileId }),
          viewport:
            width === null || height === null
              ? { _tag: "fill" }
              : presetId === null
                ? { _tag: "freeform", width, height }
                : { _tag: "preset", width, height, presetId },
        });
        if (!disposed) onConnected(state);
      } catch {
        if (!disposed)
          toastManager.add({ type: "error", title: "Could not connect the browser tab" });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [enabled, ready, tabId, environmentId, profileId, width, height, presetId, onConnected]);
  return null;
}

export function HostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly pictureInPicture: boolean;
  /** Fixed for the tab lifetime; Electron reads partition before guest attachment. */
  readonly profileId: string | undefined;
  readonly zoomFactor: number;
  readonly serverDriven?: boolean;
  /** Keeps an agent-created native server guest compositing without revealing it. */
  readonly automationOwned?: boolean;
  readonly serverRendering?: {
    readonly colorScheme: DesktopPreviewColorScheme;
    readonly zoomFactor: number;
  };
}) {
  const {
    threadRef,
    tabId,
    runtimeTabId,
    initialUrl,
    viewport,
    pictureInPicture,
    zoomFactor,
    profileId,
    serverDriven = false,
    automationOwned = false,
    serverRendering,
  } = props;
  const clientSettingsHydrated = useClientSettingsHydrated();
  const primaryHost = useAtomValue(primaryEnvironmentIdAtom) === threadRef.environmentId;
  const hostedEnvironmentIds = useDesktopBrowserHostedEnvironmentIds();
  const nativeHost = primaryHost || hostedEnvironmentIds.includes(threadRef.environmentId);
  // A late target binding must keep a guest that started as a webview on its existing render path.
  const [legacyWebviewHost] = useState(() => !nativeHost);
  const config = usePreviewWebviewConfig(threadRef.environmentId, profileId);
  const [initialSrc] = useState(() => initialUrl ?? "about:blank");
  const [tabConnection, setTabConnection] = useState<{
    readonly tabId: string;
    readonly ready: Promise<void>;
  } | null>(null);
  const hostLeaseRef = useRef<ReturnType<typeof acquireDesktopBrowserHostState> | null>(null);
  const hostState = useDesktopBrowserHostState(runtimeTabId);
  const hostRevision = useDesktopBrowserHostRevision(runtimeTabId);
  const nativeSurface = nativeHost && !legacyWebviewHost && hostState?.kind !== "webview";
  const hostKindRef = useRef<DesktopPreviewSurfaceState["kind"]>("pending");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [webviewElement, setWebviewElement] = useState<HTMLElement | null>(null);
  const crashRecoveryRef = useRef<WebviewCrashRecoveryState>(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE);
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[runtimeTabId];
      return {
        content: current?.content ?? null,
        cornerRadius: current?.cornerRadius ?? 0,
        fitSourceContent: current?.fitSourceContent ?? false,
        fittedSourceContent: current?.fittedSourceContent ?? null,
        rect: resolveBrowserSurfacePanelRect(state.byTabId, runtimeTabId),
        visible: current?.visible ?? false,
        interactive: current?.interactive ?? true,
        zIndex: current?.zIndex ?? 30,
      };
    }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releasing native control must also release keyboard focus in the guest
  useEffect(() => {
    if (!presentation.interactive) webviewElement?.blur();
  }, [presentation.interactive, webviewElement]);
  const backgroundActivity = useBrowserSurfaceStore(
    (state) => (state.activityByTabId[runtimeTabId] ?? 0) > 0,
  );
  const recordingActive = useActiveBrowserRecordingTabIds().has(runtimeTabId);
  usePreviewBridge({ threadRef, tabId, runtimeTabId, serverDriven });

  const serverColorScheme = serverRendering?.colorScheme;
  const serverZoomFactor = serverRendering?.zoomFactor;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the native host identity for this mount independently of late server binding
  useEffect(() => {
    const hostLease = acquireDesktopBrowserHostState(runtimeTabId);
    hostLeaseRef.current = hostLease;
    const unsubscribe = previewBridge?.onStateChange?.((changedTabId, state) => {
      if (changedTabId !== runtimeTabId) return;
      const kind =
        state.hostKind ?? (state.webContentsId === null ? hostKindRef.current : "webview");
      hostKindRef.current = kind;
      hostLease.update({
        kind,
        webContentsId: state.webContentsId,
        privateEntry: false,
      });
    });
    return () => {
      unsubscribe?.();
      if (hostLeaseRef.current === hostLease) hostLeaseRef.current = null;
      hostLease.release();
    };
  }, [runtimeTabId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leases the desktop preview tab and releases it on cleanup
  useEffect(() => {
    if (!clientSettingsHydrated) return;
    crashRecoveryRef.current = INITIAL_WEBVIEW_CRASH_RECOVERY_STATE;
    const lease = acquireDesktopTab(
      runtimeTabId,
      nativeHost
        ? {
            threadId: threadRef.threadId,
            tabId,
            ...(primaryHost ? {} : { environmentId: threadRef.environmentId }),
          }
        : undefined,
      nativeHost ? initialSrc : undefined,
    );
    let disposed = false;
    void lease.ready.then(
      () => {
        if (!disposed) setTabConnection({ tabId: runtimeTabId, ready: lease.ready });
      },
      () => {
        if (!disposed)
          toastManager.add({ type: "error", title: "Could not connect the browser tab" });
      },
    );
    return () => {
      disposed = true;
      setTabConnection((current) => (current?.ready === lease.ready ? null : current));
      lease.release();
    };
  }, [
    clientSettingsHydrated,
    runtimeTabId,
    nativeHost,
    primaryHost,
    tabId,
    threadRef.threadId,
    threadRef.environmentId,
    initialSrc,
  ]);

  const viewportWidth = viewport._tag === "fill" ? null : viewport.width;
  const viewportHeight = viewport._tag === "fill" ? null : viewport.height;
  const viewportPresetId = viewport._tag === "preset" ? viewport.presetId : null;
  const hostConnected = useStableCallback((state: DesktopPreviewSurfaceState) => {
    hostKindRef.current = state.kind;
    hostLeaseRef.current?.update(state);
  });
  const tabReady = tabConnection?.tabId === runtimeTabId ? tabConnection.ready : null;
  const hostConnection = (
    <OffscreenHostConnection
      key={JSON.stringify([runtimeTabId, hostState?.webContentsId ?? null, hostRevision])}
      enabled={clientSettingsHydrated && Boolean(config) && nativeSurface}
      tabId={runtimeTabId}
      environmentId={threadRef.environmentId}
      profileId={profileId}
      ready={tabReady}
      width={viewportWidth}
      height={viewportHeight}
      presetId={viewportPresetId}
      onConnected={hostConnected}
    />
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies the server color scheme to the desktop preview tab through the desktop bridge
  useEffect(() => {
    const bridge = window.desktopBridge?.preview;
    if (!bridge || serverColorScheme === undefined) return;
    withDesktopTab(runtimeTabId, () => bridge.setColorScheme(runtimeTabId, serverColorScheme));
  }, [runtimeTabId, serverColorScheme]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies the server zoom factor to the desktop preview tab through the desktop bridge
  useEffect(() => {
    const bridge = window.desktopBridge?.preview;
    if (!bridge || serverZoomFactor === undefined) return;
    withDesktopTab(runtimeTabId, () => bridge.setZoomFactor(runtimeTabId, serverZoomFactor));
  }, [runtimeTabId, serverZoomFactor]);

  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [recoverySrc, setRecoverySrc] = useState(initialSrc);
  const remountCrashedWebview = useEffectEvent(() => {
    setRecoverySrc(initialUrl ?? initialSrc);
    setWebviewGeneration((generation) => generation + 1);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the webview's webContents with the desktop bridge and listens for crashes and focus
  useEffect(() => {
    const webview = webviewElement as ElectronWebview | null;
    const bridge = previewBridge;
    if (!webview || !bridge) return;
    let disposed = false;
    let recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
    const register = () => {
      if (!tabReady) return;
      void (async () => {
        try {
          // Tab creation and webview attachment use separate effects; wait to avoid PreviewTabNotFoundError.
          await tabReady;
          if (disposed || !webview.isConnected) return;
          const webContentsId = webview.getWebContentsId();
          if (Number.isInteger(webContentsId) && webContentsId > 0) {
            await bridge.registerWebview(runtimeTabId, webContentsId);
          }
        } catch {}
      })();
    };
    const recoverGuest = () => {
      if (disposed || recoveryTimeout !== null) return;
      const recovery = planWebviewCrashRecovery(crashRecoveryRef.current, Date.now());
      if (!recovery) return;
      crashRecoveryRef.current = recovery.state;
      recoveryTimeout = setTimeout(() => {
        recoveryTimeout = null;
        if (!disposed) remountCrashedWebview();
      }, recovery.delayMs);
    };
    // Guest clicks only emit focus here; replay pointerdown to dismiss host popups.
    const dismissHostPopups = () => {
      webview.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
      );
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    webview.addEventListener("render-process-gone", recoverGuest);
    webview.addEventListener("focus", dismissHostPopups);
    register();
    return () => {
      disposed = true;
      if (recoveryTimeout !== null) clearTimeout(recoveryTimeout);
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
      webview.removeEventListener("render-process-gone", recoverGuest);
      webview.removeEventListener("focus", dismissHostPopups);
    };
  }, [runtimeTabId, tabReady, webviewElement]);

  const active = presentation.visible && presentation.rect !== null;
  const lastRect = presentation.rect;
  const layoutZoomFactor = useBrowserLayoutZoomFactor(zoomFactor);
  const viewportAspectRatio =
    viewportWidth === null || viewportHeight === null ? null : viewportWidth / viewportHeight;
  const lockedAspectRatio =
    aspectRatioLocked && viewportAspectRatio !== null ? viewportAspectRatio : null;
  const handleAspectRatioChange = (aspectRatio: number | null) => {
    setAspectRatioLocked(aspectRatio !== null);
  };
  const content = presentation.content;
  const hiddenWidth =
    viewport._tag !== "fill"
      ? viewport.width * layoutZoomFactor
      : content
        ? content.width / content.scale
        : (lastRect?.width ?? 1280);
  const hiddenHeight =
    viewport._tag !== "fill"
      ? viewport.height * layoutZoomFactor
      : content
        ? content.height / content.scale
        : (lastRect?.height ?? 800);
  // Build from primitives on each side of the resize hook to keep both objects cached.
  const containerSize =
    active && lastRect ? lastRect : { width: hiddenWidth, height: hiddenHeight };
  const deviceToolbarVisible = active && viewport._tag !== "fill" && !presentation.fitSourceContent;
  const {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout: viewportLayout,
  } = useBrowserViewportResize({
    target: { threadRef, tabId, runtimeTabId },
    viewport,
    zoomFactor: layoutZoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio: lockedAspectRatio,
  });
  const fittedSourceViewport =
    presentation.fitSourceContent && lastRect
      ? resolveFittedBrowserViewport(viewport, presentation.fittedSourceContent, layoutZoomFactor)
      : null;
  const layout =
    fittedSourceViewport && lastRect
      ? resolveBrowserViewportLayout(lastRect, fittedSourceViewport, layoutZoomFactor)
      : viewportLayout;

  const syncContentPresentation = () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    useBrowserSurfaceStore.getState().presentContent(runtimeTabId, {
      x: layout.viewportX,
      y: layout.viewportY,
      width: layout.viewportWidth,
      height: layout.viewportHeight,
      scale: layout.viewportScale,
      scrollLeft: wrapper.scrollLeft,
      scrollTop: wrapper.scrollTop,
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a frame that publishes the webview layout and scroll to the browser surface store
  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncContentPresentation);
    return () => window.cancelAnimationFrame(frameId);
  }, [syncContentPresentation]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the webview wrapper element to its origin for a new tab or viewport size
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.scrollTo({ left: 0, top: 0 });
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new tab or viewport size starts the canvas scrolled to its origin.
    runtimeTabId,
    viewport._tag,
    viewportHeight,
    viewportWidth,
  ]);

  if (!clientSettingsHydrated || !config || nativeSurface) return hostConnection;

  // Offscreen/visibility:hidden guests stop producing animation frames and
  // accepting compositor input. Keep the agent's page paintable behind the app;
  // this changes presentation only and does not grant control or focus it.
  const renderingActive =
    active ||
    backgroundActivity ||
    pictureInPicture ||
    recordingActive ||
    (serverDriven && automationOwned);
  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active,
    renderingActive,
    // Electron 43 can permanently blank a macOS webview after `visibility: hidden`.
    keepPaintableWhenInactive: isMacPlatform(navigator.platform),
    cornerRadius: presentation.cornerRadius,
    zIndex: presentation.zIndex,
    rect: lastRect,
    hiddenSize: { width: hiddenWidth, height: hiddenHeight },
  });

  return (
    <>
      {hostConnection}
      <div
        ref={wrapperRef}
        className="fixed overflow-hidden bg-muted/35"
        style={{
          ...wrapperStyle,
          ...(!presentation.interactive ? { pointerEvents: "none" } : {}),
          overscrollBehavior: "contain",
        }}
        inert={!presentation.interactive}
        onScroll={syncContentPresentation}
        data-preview-rendering={renderingActive ? "active" : "suspended"}
        data-preview-viewport={runtimeTabId}
      >
        <div
          className="relative"
          style={{ width: layout.canvasWidth, height: layout.canvasHeight }}
        >
          {deviceToolbarVisible && effectiveViewport._tag !== "fill" ? (
            <BrowserDeviceToolbar
              setting={effectiveViewport}
              width={Math.max(1, Math.round(active && lastRect ? lastRect.width : hiddenWidth))}
              aspectRatio={lockedAspectRatio}
              onAspectRatioChange={handleAspectRatioChange}
              onChange={commitViewportChange}
            />
          ) : null}
          <webview
            key={webviewGeneration}
            ref={setWebviewElement}
            // Electron needs allowpopups at attachment. React drops boolean values for unknown attributes.
            {...({ allowpopups: "true" } as unknown as { readonly allowpopups?: boolean })}
            src={webviewGeneration === 0 ? initialSrc : recoverySrc}
            partition={config.partition}
            webpreferences={
              serverDriven && automationOwned
                ? `${config.webPreferences},backgroundThrottling=false`
                : config.webPreferences
            }
            {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
            data-preview-tab={runtimeTabId}
            data-preview-server-tab={tabId}
            data-preview-viewport-mode={effectiveViewport._tag}
            data-preview-viewport-key={browserViewportSettingKey(effectiveViewport)}
            data-preview-css-width={
              fittedSourceViewport
                ? fittedSourceViewport.width
                : effectiveViewport._tag === "fill"
                  ? Math.max(1, Math.round(layout.viewportWidth / layoutZoomFactor))
                  : effectiveViewport.width
            }
            data-preview-css-height={
              fittedSourceViewport
                ? fittedSourceViewport.height
                : effectiveViewport._tag === "fill"
                  ? Math.max(1, Math.round(layout.viewportHeight / layoutZoomFactor))
                  : effectiveViewport.height
            }
            aria-hidden={active ? undefined : true}
            className={cn(
              "absolute flex overflow-hidden bg-white",
              active && !layout.fillsPanel && "ring-1 ring-border/70 shadow-sm",
            )}
            style={{
              left: layout.viewportX,
              top: layout.viewportY,
              width: layout.viewportWidth / layout.viewportScale,
              height: layout.viewportHeight / layout.viewportScale,
              transform: layout.viewportScale < 1 ? `scale(${layout.viewportScale})` : undefined,
              transformOrigin: "top left",
            }}
          />
          {active && effectiveViewport._tag !== "fill" && !fittedSourceViewport ? (
            <>
              <BrowserViewportResizeHandles
                layout={layout}
                activeDirection={activeDrag?.direction ?? null}
                onPointerDown={handleResizePointerDown}
                onKeyDown={handleResizeKeyDown}
              />
              {activeDrag ? (
                <div
                  className="pointer-events-none absolute z-40 -translate-x-1/2 rounded-md border border-border/80 bg-background/95 px-2 py-1 text-2xs font-medium tabular-nums text-foreground shadow-md backdrop-blur-sm"
                  style={{
                    left: layout.viewportX + layout.viewportWidth / 2,
                    top: layout.viewportY + 10,
                  }}
                  aria-hidden="true"
                >
                  {activeDrag.width} × {activeDrag.height}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
