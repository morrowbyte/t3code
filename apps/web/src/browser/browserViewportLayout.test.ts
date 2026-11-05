import { describe, expect, it } from "vite-plus/test";

import {
  resizeBrowserViewportFromRail,
  resolveBrowserViewportLayout,
  resolveFittedBrowserViewport,
  resolveHiddenBrowserViewportSize,
} from "./browserViewportLayout";

describe("resolveBrowserViewportLayout", () => {
  it("preserves the last logical viewport when fitting a fill-mode surface", () => {
    expect(
      resolveFittedBrowserViewport({ _tag: "fill" }, { width: 320, height: 200, scale: 0.25 }),
    ).toEqual({ _tag: "freeform", width: 1280, height: 800 });
    const input = {
      setting: { _tag: "fill" } as const,
      zoomFactor: 2,
      lastRect: { width: 900, height: 600 },
      windowSize: { width: 700, height: 500 },
    };
    expect(
      resolveHiddenBrowserViewportSize({
        ...input,
        content: { width: 320, height: 200, scale: 0.25 },
      }),
    ).toEqual({ width: 1280, height: 800 });
    expect(resolveHiddenBrowserViewportSize({ ...input, content: null })).toEqual({
      width: 900,
      height: 600,
    });
    expect(resolveHiddenBrowserViewportSize({ ...input, content: null, lastRect: null })).toEqual({
      width: 1280,
      height: 800,
    });
  });

  it("keeps the grabbed rail under the pointer across centered layout boundaries", () => {
    const available = { width: 1120, height: 818 };
    expect(
      resizeBrowserViewportFromRail(
        { width: 1120, height: 818 },
        { x: -100, y: -50 },
        available,
        1,
        "southeast",
      ),
    ).toEqual({ width: 920, height: 718 });
    expect(
      resizeBrowserViewportFromRail(
        { width: 800, height: 600 },
        { x: 300, y: 0 },
        { width: 1200, height: 800 },
        1,
        "east",
      ),
    ).toEqual({ width: 1300, height: 600 });
    expect(
      resizeBrowserViewportFromRail(
        { width: 560, height: 409 },
        { x: -100, y: 0 },
        available,
        2,
        "east",
      ),
    ).toEqual({ width: 460, height: 409 });
  });

  it("fits a hidden fixed viewport larger than the window inside the window", () => {
    const setting = { _tag: "freeform", width: 1440, height: 1700 } as const;
    const windowSize = { width: 1400, height: 1000 };
    const hidden = resolveHiddenBrowserViewportSize({
      setting,
      zoomFactor: 1,
      content: null,
      lastRect: null,
      windowSize,
    });
    expect(hidden).toEqual({ width: 1400, height: 1000 });
    const layout = resolveBrowserViewportLayout(hidden, setting);
    expect(layout.viewportWidth).toBeLessThanOrEqual(windowSize.width);
    expect(layout.viewportHeight).toBeLessThanOrEqual(windowSize.height);
    expect(layout.viewportWidth / layout.viewportScale).toBeCloseTo(setting.width);
    expect(layout.viewportHeight / layout.viewportScale).toBeCloseTo(setting.height);
    expect(layout.viewportScale).toBeCloseTo(1000 / 1700);
    expect(
      resolveHiddenBrowserViewportSize({
        setting: { _tag: "freeform", width: 1280, height: 800 },
        zoomFactor: 1,
        content: null,
        lastRect: null,
        windowSize,
      }),
    ).toEqual({ width: 1280, height: 800 });
    const cases = [
      { width: 2400, height: 800, zoom: 1, window: windowSize, hidden: [1400, 800] },
      { width: 1440, height: 1700, zoom: 2, window: windowSize, hidden: [1400, 1000] },
      { width: 1440, height: 1700, zoom: 0.5, window: windowSize, hidden: [720, 850] },
      {
        width: 1440,
        height: 1700,
        zoom: 1,
        window: { width: 900, height: 600 },
        hidden: [900, 600],
      },
    ];
    for (const entry of cases) {
      const fixed = { _tag: "freeform", width: entry.width, height: entry.height } as const;
      const size = resolveHiddenBrowserViewportSize({
        setting: fixed,
        zoomFactor: entry.zoom,
        content: null,
        lastRect: null,
        windowSize: entry.window,
      });
      expect([size.width, size.height]).toEqual(entry.hidden);
      const fitted = resolveBrowserViewportLayout(size, fixed, entry.zoom);
      expect(fitted.viewportWidth).toBeLessThanOrEqual(entry.window.width);
      expect(fitted.viewportHeight).toBeLessThanOrEqual(entry.window.height);
      expect(fitted.viewportWidth / fitted.viewportScale / entry.zoom).toBeCloseTo(entry.width);
      expect(fitted.viewportHeight / fitted.viewportScale / entry.zoom).toBeCloseTo(entry.height);
    }
    expect(
      resolveHiddenBrowserViewportSize({
        setting: { _tag: "preset", presetId: "nest-hub-max", width: 1280, height: 800 },
        zoomFactor: 2,
        content: null,
        lastRect: null,
        windowSize,
      }),
    ).toEqual({ width: 1400, height: 1000 });
  });
});
