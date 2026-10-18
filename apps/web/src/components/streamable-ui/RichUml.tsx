import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { useEffect, useRef, useState } from "react";
import { MinusIcon, PlusIcon, ScanIcon, RotateCcwIcon } from "lucide-react";
import type { EnvironmentId, UmlRenderRequest, UmlRenderResult } from "@t3tools/contracts";
import type { VisualUml } from "@t3tools/shared/streamableUi";
import {
  createUmlSnapshotQueue,
  renderEnvironmentUml,
} from "@t3tools/client-runtime/state/streamable-uml";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";

function readPalette(): UmlRenderRequest["palette"] {
  const style = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const hex = (token: string, diagramStroke = false) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = style.getPropertyValue("--background").trim();
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = style.getPropertyValue(token).trim();
    context.fillRect(0, 0, 1, 1);
    if (diagramStroke) {
      context.globalAlpha = 0.5;
      context.fillStyle = style.getPropertyValue("--muted-foreground").trim();
      context.fillRect(0, 0, 1, 1);
      context.globalAlpha = 1;
    }
    return `#${[...context.getImageData(0, 0, 1, 1).data]
      .slice(0, 3)
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;
  };
  return {
    background: hex("--background"),
    surface: hex("--card"),
    foreground: hex("--foreground"),
    muted: hex("--muted-foreground"),
    border: hex("--border", true),
    primary: hex("--primary"),
  };
}

async function requestUmlSnapshot(
  connection: PreparedConnection,
  input: UmlRenderRequest,
  signal: AbortSignal,
) {
  const request = connectionAtomRuntime.fn<void>()(() =>
    Effect.gen(function* () {
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      return yield* renderEnvironmentUml({
        prepared: connection,
        signer,
        remoteAuthorization,
        signal,
        diagram: input,
      });
    }),
  );
  appAtomRegistry.set(request, undefined);
  const result = await Effect.runPromise(
    Effect.result(AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true })),
  );
  if (Result.isFailure(result)) throw result.failure;
  if (result.success.status === "ready") {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.success.svg)}`;
    await image.decode();
  }
  return result.success;
}

export function RichUml({
  diagram,
  environmentId,
}: {
  diagram: VisualUml;
  environmentId: EnvironmentId | null;
}) {
  const prepared = usePreparedConnection(environmentId);
  const [palette, setPalette] = useState(readPalette);
  const [frame, setFrame] = useState<
    Extract<UmlRenderResult, { status: "ready" }> & { sourceKey: string }
  >();
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [textScale, setTextScale] = useState(() =>
    Math.max(1, parseFloat(getComputedStyle(document.documentElement).fontSize) / 16),
  );
  const viewport = useRef<HTMLDivElement>(null);
  const queue = useRef<ReturnType<typeof createUmlSnapshotQueue> | null>(null);
  const snapshots = useRef(diagram.snapshots);
  useEffect(() => {
    snapshots.current = diagram.snapshots;
    queue.current?.update(diagram.snapshots);
  }, [diagram.snapshots]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTextScale(
        Math.max(1, parseFloat(getComputedStyle(document.documentElement).fontSize) / 16),
      );
      setPalette((current) => {
        const next = readPalette();
        return JSON.stringify(current) === JSON.stringify(next) ? current : next;
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (prepared._tag === "None") return;
    const connection = prepared.value;
    let live = true;
    const next = createUmlSnapshotQueue({
      render: (source, signal) =>
        requestUmlSnapshot(connection, { kind: diagram.kind, source, palette }, signal),
      onResult: (result, source) => {
        if (!live) return;
        if (result.status === "ready") {
          setFrame({
            ...result,
            sourceKey:
              snapshots.current.findLast((snapshot) => snapshot.source === source)?.key ?? "",
          });
          setError(false);
        } else setError(true);
      },
    });
    queue.current = next;
    next.update(snapshots.current);
    return () => {
      live = false;
      next.dispose();
      queue.current = null;
    };
  }, [prepared, diagram.kind, palette]);
  return (
    <div className="grid min-w-0 gap-2" data-iui-uml={diagram.kind}>
      <div role="group" aria-label={`${diagram.title} zoom`} className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out diagram"
          disabled={!frame}
          onClick={() => setZoom((v) => Math.max(0.25, v / 1.25))}
        >
          <MinusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in diagram"
          disabled={!frame}
          onClick={() => setZoom((v) => Math.min(3, v * 1.25))}
        >
          <PlusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Fit diagram"
          disabled={!frame}
          onClick={() => {
            if (!frame) return;
            setZoom(
              Math.min(
                1,
                (viewport.current?.clientWidth ?? frame.width) / (frame.width * textScale),
              ),
            );
          }}
        >
          <ScanIcon />
        </Button>
        {error ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Retry diagram update"
            onClick={() => queue.current?.retry()}
          >
            <RotateCcwIcon />
          </Button>
        ) : null}
      </div>
      {frame ? (
        <div
          ref={viewport}
          role="region"
          aria-label={diagram.title}
          tabIndex={0}
          className="max-h-[min(40rem,70dvh)] min-w-0 overflow-auto scrollbar-gutter-both rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring"
        >
          <img
            className="mx-auto"
            data-uml-snapshot={frame.sourceKey}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(frame.svg)}`}
            alt={`${diagram.title} · ${diagram.kind} UML diagram`}
            draggable={false}
            style={{
              width: frame.width * zoom * textScale,
              height: frame.height * zoom * textScale,
              maxWidth: "none",
            }}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" role="status">
          {diagram.snapshots.length === 0
            ? "Waiting for diagram data…"
            : error || prepared._tag === "None"
              ? "Diagram unavailable."
              : "Rendering diagram…"}
        </p>
      )}
      {error && frame ? (
        <p className="text-xs text-muted-foreground" role="status">
          Latest diagram update unavailable.
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs underline focus-visible:outline-2 focus-visible:outline-ring">
          View notation
        </summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap pt-2 text-xs">
          {diagram.snapshots.at(-1)?.source}
        </pre>
      </details>
    </div>
  );
}
