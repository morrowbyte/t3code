import { useRef, useState } from "react";
import type { PhoneViewer } from "@t3tools/client-runtime/device/phone-viewer";
import type { createPhoneInteraction } from "@t3tools/client-runtime/device/phone-interaction";
import { GALAXY_S24_ULTRA_SHAPE } from "@t3tools/client-runtime/device/shape-profile";
import { Button } from "~/components/ui/button";
import { mountDeviceViewer } from "./mountDeviceViewer";

const loadPhoneViewer = () => import("@t3tools/client-runtime/device/phone-viewer");

export default function S24ModelPreview({ initialView }: { readonly initialView: string }) {
  const viewerRef = useRef<PhoneViewer | null>(null);
  const interactionRef = useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
  const [view, setView] = useState(initialView);
  const [unavailable, setUnavailable] = useState(false);
  const choose = (next: string) => {
    interactionRef.current?.end();
    viewerRef.current?.setView(next === "back" ? "back" : "front");
    viewerRef.current?.setScreen({
      width: 1440,
      height: 3120,
      orientation: next === "landscape" ? "landscape_right" : "portrait",
    });
    setView(next);
  };
  const mount = (canvas: HTMLCanvasElement | null) => {
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const source = document.createElement("canvas");
    source.width = 1440;
    source.height = 3120;
    const context = source.getContext("2d");
    if (!context) {
      setUnavailable(true);
      return;
    }
    context.fillStyle = "#c5cbd1";
    context.fillRect(0, 0, source.width, source.height);
    context.strokeStyle = "#adb5bd";
    context.lineWidth = 2;
    for (let x = 0; x <= source.width; x += 120) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, source.height);
      context.stroke();
    }
    for (let y = 0; y <= source.height; y += 120) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(source.width, y);
      context.stroke();
    }
    context.fillStyle = "#414951";
    context.textAlign = "center";
    context.font = "54px sans-serif";
    context.fillText("MODELLVORSCHAU", 720, 1510);
    context.font = "36px sans-serif";
    context.fillText("Kein Gerätestream", 720, 1600);
    return mountDeviceViewer(canvas, host, {
      load: () =>
        loadPhoneViewer().then(
          ({ createPhoneViewer }) =>
            () =>
              createPhoneViewer({
                canvas,
                source,
                profile: GALAXY_S24_ULTRA_SHAPE,
                onUnavailable: () => setUnavailable(true),
              }),
        ),
      touch: () => {},
      viewerRef,
      interactionRef,
      onInputCancel: () => {},
      onResetReady: () => {},
      onFrameListener: () => {},
      onUnavailable: () => setUnavailable(true),
      ready: ({ viewer }) => {
        viewer.setView(initialView === "back" ? "back" : "front");
        viewer.setScreen({
          width: 1440,
          height: 3120,
          orientation: initialView === "landscape" ? "landscape_right" : "portrait",
        });
        return { frame: viewer.frameUpdated };
      },
    });
  };
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b border-border p-3">
        <div className="mr-auto">
          <h1 className="font-medium">Galaxy S24 Ultra · Modellvorschau</h1>
          <p className="text-xs text-muted-foreground">
            DEV · Statisches Testbild · Kein Gerätestream · Keine Gerätebedienung
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={view === "front" ? "secondary" : "ghost"}
            onClick={() => choose("front")}
          >
            Vorderseite
          </Button>
          <Button
            size="sm"
            variant={view === "back" ? "secondary" : "ghost"}
            onClick={() => choose("back")}
          >
            Rückseite
          </Button>
          <Button
            size="sm"
            variant={view === "landscape" ? "secondary" : "ghost"}
            onClick={() => choose("landscape")}
          >
            Querformat
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Verkleinern"
            onClick={() => viewerRef.current?.zoomBy(-0.15)}
          >
            −
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Vergrößern"
            onClick={() => viewerRef.current?.zoomBy(0.15)}
          >
            +
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              choose("front");
              viewerRef.current?.resetPose();
            }}
          >
            Reset
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {unavailable ? (
          <p role="alert" className="absolute inset-0 p-6">
            3D ist in diesem Browser nicht verfügbar.
          </p>
        ) : null}
        <canvas
          ref={mount}
          aria-label="Interaktives S24-Ultra-Modell. Ziehen zum Drehen, Trackpad-Pinch zum Zoomen."
          className="size-full touch-none"
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              !interactionRef.current?.begin(event.pointerId, point(event), true)
            )
              return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => interactionRef.current?.move(event.pointerId, point(event))}
          onPointerUp={(event) => interactionRef.current?.end(event.pointerId)}
          onPointerCancel={(event) => interactionRef.current?.end(event.pointerId)}
          onLostPointerCapture={(event) => interactionRef.current?.end(event.pointerId)}
        />
      </div>
    </main>
  );
}
