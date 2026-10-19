import { describe, expect, it } from "vite-plus/test";
import {
  annotationImageRect,
  annotationPoint,
  annotationPath,
  annotationRasterSize,
} from "./imageAnnotation";

describe("image annotation coordinates", () => {
  it("excludes letterboxing and preserves image coordinates through zoom and pan", () => {
    const image = { width: 800, height: 400 };
    const viewport = { width: 400, height: 600 };
    const fit = annotationImageRect(image, viewport);
    expect(fit).toEqual({ x: 0, y: 200, width: 400, height: 200 });
    expect(annotationPoint({ x: 200, y: 100 }, fit)).toBeNull();
    expect(annotationPoint({ x: 100, y: 250 }, fit)).toEqual({ x: 0.25, y: 0.25 });
    const zoomed = annotationImageRect(image, viewport, 2, { x: 30, y: -20 });
    expect(annotationPoint({ x: 30, y: 180 }, zoomed)).toEqual({ x: 0.25, y: 0.25 });
    expect(
      annotationPath(
        [
          { x: 0.25, y: 0.25 },
          { x: 1, y: 1 },
        ],
        800,
        400,
      ),
    ).toBe("M200 100 L800 400");
  });

  it("bounds native raster allocation before exporting", () => {
    expect(annotationRasterSize(4000, 4000)).toEqual({ width: 4000, height: 4000 });
    for (const size of [
      [0, 1],
      [NaN, 1],
      [1.5, 2],
      [8193, 1],
      [5000, 4000],
    ]) {
      expect(() => annotationRasterSize(size[0]!, size[1]!)).toThrow();
    }
  });
});
