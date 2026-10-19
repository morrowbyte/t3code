import { describe, expect, it } from "vite-plus/test";
import { annotationPoint } from "./ImageAnnotation";

describe("annotationPoint", () => {
  it("keeps image-space coordinates through fit, zoom, pan and narrow layouts", () => {
    for (const bounds of [
      { left: 80, top: 120, width: 720, height: 400 },
      { left: -160, top: -90, width: 1440, height: 800 },
      { left: 16, top: 200, width: 358, height: 199 },
    ]) {
      const point = annotationPoint(
        { clientX: bounds.left + bounds.width * 0.75, clientY: bounds.top + bounds.height * 0.2 },
        bounds,
      );
      expect(point?.x).toBeCloseTo(0.75);
      expect(point?.y).toBeCloseTo(0.2);
    }
  });

  it("clips captured pointers at the image edges and rejects unusable bounds", () => {
    const bounds = { left: 10, top: 20, width: 100, height: 50 };
    expect(annotationPoint({ clientX: -100, clientY: 100 }, bounds)).toEqual({ x: 0, y: 1 });
    expect(annotationPoint({ clientX: 10, clientY: 20 }, { ...bounds, width: 0 })).toBeNull();
    expect(annotationPoint({ clientX: NaN, clientY: 20 }, bounds)).toBeNull();
  });
});
