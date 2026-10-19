export interface ImageAnnotationPoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageAnnotationStroke {
  readonly color: string;
  /** Fraction of the shorter, intrinsically oriented image dimension. */
  readonly width: number;
  readonly points: ReadonlyArray<ImageAnnotationPoint>;
}

export interface AnnotationImage {
  readonly image: HTMLImageElement;
  readonly dispose: () => void;
}

const MAX_ANNOTATION_PIXELS = 40_000_000;

export function annotationPoint(
  client: { readonly clientX: number; readonly clientY: number },
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
): ImageAnnotationPoint | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const x = (client.clientX - bounds.left) / bounds.width;
  const y = (client.clientY - bounds.top) / bounds.height;
  return Number.isFinite(x) && Number.isFinite(y)
    ? { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
    : null;
}

export function drawAnnotationStrokes(
  context: CanvasRenderingContext2D,
  size: { readonly width: number; readonly height: number },
  strokes: ReadonlyArray<ImageAnnotationStroke>,
): void {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    if (!/^#[\da-f]{6}$/i.test(stroke.color) || !Number.isFinite(stroke.width) || stroke.width <= 0)
      throw new Error("The image contains an invalid stroke.");
    if (!stroke.points.length) continue;
    const points = stroke.points.map((point) => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
        throw new Error("The image contains an invalid point.");
      return {
        x: Math.min(1, Math.max(0, point.x)) * size.width,
        y: Math.min(1, Math.max(0, point.y)) * size.height,
      };
    });
    const first = points[0]!;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = Math.max(1, stroke.width * Math.min(size.width, size.height));
    context.beginPath();
    if (points.length === 1) {
      context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(first.x, first.y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
  }
  context.restore();
}

export async function loadAnnotationImage(
  src: string,
  signal: AbortSignal,
): Promise<AnnotationImage> {
  const response = await fetch(src, { signal, credentials: "include" });
  if (!response.ok)
    throw new Error("The image could not be loaded for editing. Reopen it and try again.");
  const url = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error("The image could not be decoded.");
    if (image.naturalWidth * image.naturalHeight > MAX_ANNOTATION_PIXELS)
      throw new Error("This image is too large to annotate. Use an image below 40 megapixels.");
    return { image, dispose: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function exportAnnotatedImage(
  image: HTMLImageElement,
  strokes: ReadonlyArray<ImageAnnotationStroke>,
  name: string,
): Promise<File> {
  if (!strokes.some((stroke) => stroke.points.length > 0))
    throw new Error("Add a mark before sending the image.");
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  if (!canvas.width || !canvas.height || canvas.width * canvas.height > MAX_ANNOTATION_PIXELS)
    throw new Error("The image cannot be exported at this size.");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image editing is unavailable in this browser.");
  context.drawImage(image, 0, 0);
  drawAnnotationStrokes(context, canvas, strokes);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("The annotated image could not be exported.")),
      "image/png",
    ),
  );
  const base =
    name
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${base}-annotated.png`, { type: "image/png" });
}
