import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface AnnotationPoint {
  readonly x: number;
  readonly y: number;
}

export interface AnnotationStroke {
  readonly color: string;
  readonly width: number;
  readonly points: readonly AnnotationPoint[];
}

export interface AnnotationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AnnotatedImage {
  readonly uri: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface ImageAnnotationDraft {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly image: AnnotatedImage;
  readonly text: string;
  readonly signal: AbortSignal;
}

export type SendImageAnnotation = (
  image: AnnotatedImage,
  text: string,
  signal: AbortSignal,
) => Promise<boolean>;

export function annotationImageRect(
  image: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  zoom = 1,
  pan: AnnotationPoint = { x: 0, y: 0 },
): AnnotationRect {
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height) * zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (viewport.width - width) / 2 + pan.x,
    y: (viewport.height - height) / 2 + pan.y,
    width,
    height,
  };
}

export function annotationPoint(
  point: AnnotationPoint,
  rect: AnnotationRect,
): AnnotationPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (point.x - rect.x) / rect.width;
  const y = (point.y - rect.y) / rect.height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}

export function annotationPath(points: readonly AnnotationPoint[], width: number, height: number) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x * width} ${point.y * height}`)
    .join(" ");
}

export function annotationRasterSize(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16_000_000
  ) {
    throw new Error(
      "This image is too large to annotate. Choose an image up to 16 megapixels and 8192 pixels per side.",
    );
  }
  return { width, height };
}
