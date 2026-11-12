// @effect-diagnostics nodeBuiltinImport:off - reads the installed native JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const renderState = source.slice(
    source.indexOf("function setInitialRenderState("),
    source.indexOf("// src/core/finishInitialScroll.ts"),
  );
  const watchdog = source.slice(
    source.indexOf("var INSET_END_SETTLE_WATCHDOG_FRAMES"),
    source.indexOf("function dispatchInitialScroll("),
  );
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>();
  const scrollTo = vi.fn();
  const onLoad = vi.fn();
  const state = {
    props: { data: ["message"], onLoad, drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 },
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
  };
  const ctx = { state };
  let contentSize = 1200;
  let inset = 100;
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n({ start: startInsetEndSettleWatchdog, complete: setInitialRenderState })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => inset,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
    },
  ) as {
    start: (context: typeof ctx) => void;
    complete: (context: typeof ctx, flags: Record<string, boolean>) => void;
  };
  return {
    state,
    scrollTo,
    onLoad,
    start: () => api.start(ctx),
    complete: () => api.complete(ctx, {}),
    ready: () => values.get("readyToRender") === true,
    resize: (size: number) => {
      contentSize = size;
    },
    setInset: (value: number) => {
      inset = value;
    },
    advance(count: number) {
      for (let index = 0; index < count; index++) {
        const batch = frames.splice(0);
        for (const frame of batch) frame();
      }
    },
  };
}

function createInsetFollowList(bundle: string, horizontal = false) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const maintain = source.slice(
    source.indexOf("function doMaintainScrollAtEnd("),
    source.indexOf("// src/utils/requestAdjust.ts"),
  );
  const imperative = source.slice(
    source.indexOf("function createImperativeHandle("),
    source.indexOf("// src/utils/getAlwaysRenderIndices.ts"),
  );
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const scrollTo = vi.fn();
  const scrollToEnd = vi.fn();
  const state = {
    props: {
      data: ["message", "question"],
      horizontal,
      maintainScrollAtEnd: { animated: false },
    },
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: true,
    scrollLength: 553,
    scroll: 1661,
    refScroller: { current: { scrollTo, scrollToEnd } },
  };
  const ctx = { state };
  let inset = 541;
  let followsEnd = true;
  const api = NodeVM.runInNewContext(
    `${maintain}\n${imperative}\n({ maintain: doMaintainScrollAtEnd, list: createImperativeHandle(ctx) })`,
    {
      ctx,
      Platform: { OS: "android" },
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      setTimeout: (callback: () => void) => timers.push(callback),
      getContentSize: () => 1673 + inset,
      getContentInsetStartAdjustment: () => 0,
      isHorizontalRTL: () => false,
      peek$: (_ctx: unknown, key: string) =>
        key === "isWithinMaintainScrollAtEndThreshold" ? followsEnd : undefined,
      setContentInsetOverride: (_ctx: unknown, value: { bottom: number }) => {
        const changed = inset !== value.bottom;
        inset = value.bottom;
        return changed;
      },
      updateScroll: vi.fn(),
      retargetActiveInitialScrollAtEnd: vi.fn(),
    },
  ) as {
    maintain: (context: typeof ctx) => void;
    list: { reportContentInset: (value: { bottom: number }) => void };
  };
  return {
    scrollTo,
    scrollToEnd,
    maintain: () => api.maintain(ctx),
    reportInset: (bottom: number) => api.list.reportContentInset({ bottom }),
    setFollowsEnd: (value: boolean) => {
      followsEnd = value;
    },
    advance() {
      for (const frame of frames.splice(0)) frame();
      for (const timer of timers.splice(0)) timer();
    },
  };
}

describe.each(["react-native.js", "react-native.mjs"])(
  "initial inset end reveal (%s)",
  (bundle) => {
    it("waits for the native offset instead of the optimistic scroll target", () => {
      const list = createList(bundle);
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 400 });
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("does not count an in-flight scroll as stability", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = 400;
      list.state.scrollingTo = { offset: 400 };
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.scrollingTo = undefined;
      list.state.maintainingScrollAtEnd = true;
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.maintainingScrollAtEnd = false;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("waits for a stable end target even when native scrolling follows each measurement", () => {
      const list = createList(bundle);
      list.start();
      for (let index = 0; index < 10; index++) {
        list.resize(1200 + index * 10);
        list.state.lastNativeScroll = 400 + index * 10;
        list.advance(1);
      }
      expect(list.ready()).toBe(false);
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("keeps the reveal bounded when native events never arrive", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = undefined;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.advance(32);
      expect(list.ready()).toBe(true);
    });

    it("releases control on drag and never starts another initial hold", () => {
      const list = createList(bundle);
      list.start();
      list.state.didUserDrag = true;
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.complete();
      list.start();
      list.advance(20);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("uses the current inset after a loaded question collapses and preserves history readers", () => {
      const list = createInsetFollowList(bundle);
      list.reportInset(95.5);
      list.advance();
      expect(list.scrollTo).toHaveBeenLastCalledWith({ animated: false, x: 0, y: 1215.5 });
      expect(list.scrollToEnd).not.toHaveBeenCalled();

      list.maintain();
      list.reportInset(541);
      list.advance();
      expect(list.scrollTo).toHaveBeenLastCalledWith({ animated: false, x: 0, y: 1661 });
      expect(list.scrollToEnd).not.toHaveBeenCalled();
      list.advance();
      list.scrollTo.mockClear();
      list.setFollowsEnd(false);
      list.reportInset(95.5);
      list.advance();
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.setFollowsEnd(true);
      list.reportInset(95.5);
      list.advance();
      expect(list.scrollTo).not.toHaveBeenCalled();

      const horizontalList = createInsetFollowList(bundle, true);
      horizontalList.reportInset(95.5);
      horizontalList.advance();
      expect(horizontalList.scrollToEnd).not.toHaveBeenCalled();
      expect(horizontalList.scrollTo).not.toHaveBeenCalled();
      horizontalList.maintain();
      horizontalList.advance();
      expect(horizontalList.scrollToEnd).toHaveBeenCalledWith({ animated: false });
      expect(horizontalList.scrollTo).not.toHaveBeenCalled();
    });
  },
);
