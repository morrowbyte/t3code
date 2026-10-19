import { useEffect, useRef, useState, type ReactNode } from "react";
import { MinusIcon, PlusIcon, RotateCcwIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  annotationPoint,
  drawAnnotationStrokes,
  exportAnnotatedImage,
  loadAnnotationImage,
  type AnnotationImage,
  type ImageAnnotationStroke,
} from "./ImageAnnotation";

const COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Yellow", value: "#facc15" },
  { name: "Blue", value: "#38bdf8" },
  { name: "Black", value: "#111827" },
  { name: "White", value: "#ffffff" },
] as const;
const WIDTHS = [
  { name: "Thin", value: 0.004 },
  { name: "Medium", value: 0.008 },
  { name: "Thick", value: 0.016 },
] as const;

export interface ImageAnnotationEditorProps {
  readonly src: string;
  readonly name: string;
  readonly renderImage: (overlay: ReactNode) => ReactNode;
  readonly onZoom: (factor: number) => void;
  readonly onFit: () => void;
  readonly onCancel: () => void;
  readonly onSend: (file: File, text: string, signal: AbortSignal) => Promise<boolean>;
}

export function ImageAnnotationEditor({
  src,
  name,
  renderImage,
  onZoom,
  onFit,
  onCancel,
  onSend,
}: ImageAnnotationEditorProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const decoded = useRef<AnnotationImage | null>(null);
  const active = useRef<{
    color: string;
    width: number;
    points: Array<{ x: number; y: number }>;
    pointerId: number;
  } | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [strokes, setStrokes] = useState<ReadonlyArray<ImageAnnotationStroke>>([]);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [width, setWidth] = useState<number>(WIDTHS[1].value);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let loaded: AnnotationImage | null = null;
    void loadAnnotationImage(src, controller.signal)
      .then((result) => {
        loaded = result;
        if (controller.signal.aborted) {
          result.dispose();
          return;
        }
        decoded.current = result;
        setSize({ width: result.image.naturalWidth, height: result.image.naturalHeight });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "The image could not be loaded for editing.",
          );
      });
    return () => {
      controller.abort();
      attempt.current?.abort();
      loaded?.dispose();
      decoded.current = null;
    };
  }, [src]);

  const redraw = () => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, size.width, size.height);
    drawAnnotationStrokes(context, size, strokes);
  };
  useEffect(redraw, [strokes, size]);
  const undo = () => {
    if (active.current) {
      active.current = null;
      setDrawing(false);
      redraw();
    } else setStrokes((current) => current.slice(0, -1));
  };
  const send = async () => {
    if (locked.current || !decoded.current || !strokes.length || active.current) return;
    locked.current = true;
    setSending(true);
    setError(null);
    const controller = new AbortController();
    attempt.current = controller;
    try {
      const file = await exportAnnotatedImage(decoded.current.image, strokes, name);
      controller.signal.throwIfAborted();
      const accepted = await onSend(file, message, controller.signal);
      if (!accepted && !controller.signal.aborted)
        setError("The image was not sent. Your marks and message are still here.");
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "The annotated image could not be sent.");
    } finally {
      locked.current = false;
      if (!controller.signal.aborted) setSending(false);
    }
  };

  const overlay = (
    <canvas
      ref={canvas}
      width={size.width || 1}
      height={size.height || 1}
      role="img"
      aria-label="Draw on image"
      tabIndex={0}
      className="absolute inset-0 h-full w-full touch-none cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onPointerDown={(event) => {
        if (!size.width || sending || active.current || event.button !== 0) return;
        const point = annotationPoint(event, event.currentTarget.getBoundingClientRect());
        if (!point) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        active.current = { color, width, points: [point], pointerId: event.pointerId };
        setDrawing(true);
        const context = event.currentTarget.getContext("2d");
        if (context) drawAnnotationStrokes(context, size, [active.current]);
      }}
      onPointerMove={(event) => {
        const stroke = active.current;
        if (!stroke || stroke.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        const coalesced = event.nativeEvent.getCoalescedEvents?.();
        const points = (coalesced?.length ? coalesced : [event.nativeEvent])
          .map((point) => annotationPoint(point, bounds))
          .filter((point) => point !== null);
        if (!points.length) return;
        const context = event.currentTarget.getContext("2d");
        if (context)
          drawAnnotationStrokes(context, size, [
            { ...stroke, points: [stroke.points[stroke.points.length - 1]!, ...points] },
          ]);
        stroke.points.push(...points);
      }}
      onPointerUp={(event) => {
        const stroke = active.current;
        if (!stroke || stroke.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const finalPoint = annotationPoint(event, event.currentTarget.getBoundingClientRect());
        if (finalPoint) stroke.points.push(finalPoint);
        active.current = null;
        setDrawing(false);
        setStrokes((current) => [
          ...current,
          { color: stroke.color, width: stroke.width, points: stroke.points },
        ]);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        active.current = null;
        setDrawing(false);
        redraw();
      }}
      onLostPointerCapture={() => {
        if (active.current) {
          active.current = null;
          setDrawing(false);
          redraw();
        }
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !sending) {
          event.preventDefault();
          event.stopPropagation();
          undo();
        }
      }}
    />
  );

  return (
    <div
      className="flex min-h-0 max-w-full flex-col items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-2xl"
      aria-label="Image annotation editor"
    >
      <div
        role="toolbar"
        aria-label="Annotation tools"
        className="flex max-w-full flex-wrap items-center justify-center gap-1"
      >
        {COLORS.map((entry) => (
          <Button
            key={entry.value}
            size="icon-sm"
            variant={color === entry.value ? "secondary" : "ghost"}
            aria-label={entry.name}
            aria-pressed={color === entry.value}
            disabled={sending}
            onClick={() => setColor(entry.value)}
          >
            <span
              className="size-4 rounded-full border border-border"
              style={{ backgroundColor: entry.value }}
            />
          </Button>
        ))}
        <span className="mx-1 h-5 border-l border-border" />
        {WIDTHS.map((entry, index) => (
          <Button
            key={entry.name}
            size="icon-sm"
            variant={width === entry.value ? "secondary" : "ghost"}
            aria-label={`${entry.name} stroke`}
            aria-pressed={width === entry.value}
            disabled={sending}
            onClick={() => setWidth(entry.value)}
          >
            <MinusIcon strokeWidth={index + 1} />
          </Button>
        ))}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Undo mark"
          disabled={sending || (!strokes.length && !drawing)}
          onClick={undo}
        >
          <Undo2Icon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Clear marks"
          disabled={sending || (!strokes.length && !drawing)}
          onClick={() => {
            active.current = null;
            setDrawing(false);
            setStrokes([]);
            redraw();
          }}
        >
          <Trash2Icon />
        </Button>
        <span className="mx-1 h-5 border-l border-border" />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => onZoom(1 / 1.5)}
        >
          <MinusIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={() => onZoom(1.5)}>
          <PlusIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Fit image" onClick={onFit}>
          <RotateCcwIcon />
        </Button>
      </div>
      {renderImage(overlay)}
      <div className="w-full min-w-0 max-w-2xl space-y-2">
        <Textarea
          size="sm"
          aria-label="Message with annotation"
          placeholder="Add a message…"
          value={message}
          disabled={sending}
          onChange={(event) => setMessage(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={sending || !size.width || !strokes.length || drawing}
            onClick={() => {
              void send();
            }}
          >
            {sending ? "Sending…" : "Send annotation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
