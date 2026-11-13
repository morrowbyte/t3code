import type { PreviewViewportSetting, ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import {
  resolveBrowserViewportLayout,
  resolveFittedBrowserViewport,
} from "./browserViewportLayout";
import { useBrowserLayoutZoomFactor } from "./useBrowserLayoutZoomFactor";
import { useBrowserViewportResize } from "./useBrowserViewportResize";

export function OffscreenBrowserViewport(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly visible: boolean;
  readonly interactive: boolean;
  readonly focusOnly?: boolean;
  readonly fitSourceContent: boolean;
  readonly children: ReactNode;
}) {
  const { runtimeTabId, viewport, fitSourceContent } = props;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const presentation = useBrowserSurfaceStore((state) => state.byTabId[runtimeTabId]);
  const zoomFactor = useBrowserLayoutZoomFactor(props.zoomFactor);
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
  const containerSize = presentation?.rect ?? { width: 1, height: 1 };
  const deviceToolbarVisible = viewport._tag !== "fill" && !fitSourceContent;
  const aspectRatio =
    aspectRatioLocked && viewport._tag !== "fill" ? viewport.width / viewport.height : null;
  const {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout: viewportLayout,
  } = useBrowserViewportResize({
    target: { threadRef: props.threadRef, tabId: props.tabId, runtimeTabId },
    viewport,
    zoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio,
  });
  const layout = fitSourceContent
    ? resolveBrowserViewportLayout(
        containerSize,
        resolveFittedBrowserViewport(
          viewport,
          presentation?.fittedSourceContent ?? null,
          zoomFactor,
        ),
        zoomFactor,
      )
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the local canvas layout for pointer and annotation mapping
  useEffect(() => {
    syncContentPresentation();
  }, [syncContentPresentation]);

  return (
    <div className="absolute inset-0">
      <BrowserSurfaceSlot
        tabId={runtimeTabId}
        visible={props.visible}
        interactive={props.interactive}
        fitSourceContent={fitSourceContent}
        className="pointer-events-none absolute inset-0"
      />
      <div
        ref={wrapperRef}
        className="absolute inset-0 overflow-hidden bg-muted/35"
        onScroll={syncContentPresentation}
        inert={!props.interactive && !props.focusOnly}
      >
        <div
          className="relative"
          style={{ width: layout.canvasWidth, height: layout.canvasHeight }}
        >
          {deviceToolbarVisible && effectiveViewport._tag !== "fill" ? (
            <div inert={!props.interactive}>
              <BrowserDeviceToolbar
                setting={effectiveViewport}
                width={containerSize.width}
                aspectRatio={aspectRatio}
                onAspectRatioChange={(ratio) => setAspectRatioLocked(ratio !== null)}
                onChange={commitViewportChange}
              />
            </div>
          ) : null}
          <div
            className="absolute"
            style={{
              left: layout.viewportX,
              top: layout.viewportY,
              width: layout.viewportWidth,
              height: layout.viewportHeight,
            }}
          >
            {props.children}
          </div>
          {effectiveViewport._tag !== "fill" && !fitSourceContent ? (
            <div inert={!props.interactive}>
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
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
