import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Playwright download mocks perform real file operations outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import {
  type DesktopBrowserPrivateEntryResponse,
  type BrowserRecordingFrameRate,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { SessionControl } from "./SessionControl.ts";

vi.mock("./ServerBrowserContexts.ts", () => ({
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      return makeEncoderPage() as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      desktopConnections.push({ endpoint, context });
      desktopDetaches.emit("connected");
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeFrame(url = "about:blank") {
  const frame = {
    url: () => url,
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

function makeSession(frame?: ReturnType<typeof makeFrame>) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, listener: () => void) => events.on(name, listener)),
    emit: (name: string) => events.emit(name),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      // Snapshots shrink their screenshot in the page; the header stands in for the result.
      if (method === "Runtime.callFunctionOn") return { result: { value: PNG_HEADER } };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId: (input as { worldName?: string }).worldName === "t3-preview" ? 1 : 7,
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      if (method === "Input.dispatchKeyEvent" && (input as { commands?: unknown }).commands) {
        if (focusedFrame) focusedFrame.copy = keyCopy || focusedFrame.copy;
        else pageCopy = keyCopy || pageCopy;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      return { result: { value: "evaluated" } };
    }),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const registered = Promise.withResolvers<void>();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
  let viewport = { width: 1280, height: 800 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    nativeFileChooser,
    setChooserFiles,
    openFileChooser: () => {
      if (
        !events.emit("filechooser", {
          isMultiple: () => false,
          element: () => ({ getAttribute: async () => ".csv" }),
          setFiles: setChooserFiles,
        })
      ) {
        nativeFileChooser();
      }
    },
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => {
      // createTab reads the page's frames after registering the tab.
      registered.resolve();
      return [page];
    },
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: () => viewport,
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  const context = {
    page,
    sessions,
    registered: registered.promise,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
      );
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

// Runs the real encoder script against fake canvas and MediaRecorder globals.
function makeEncoderPage() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, fillRect() {} }),
    captureStream: (frameRate?: number) => ({ frameRate, getTracks: () => [] }),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    onstart: (() => void) | null = null;
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.onstart?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: () => canvas },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async () => ({ width: 1280, height: 800, close() {} }),
    atob,
    Blob,
    performance,
  };
  sandbox.window = sandbox;
  const context = NodeVM.createContext(sandbox);
  return {
    ...makeContext().page,
    evaluate: vi.fn(async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      typeof script === "string"
        ? NodeVM.runInContext(script, context)
        : NodeVM.runInContext(`(${script.toString()})`, context)(arg),
    ),
  };
}

const contexts: ReturnType<typeof makeContext>[] = [];
const encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }> = [];
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let initialNavigation: (() => Promise<void>) | null = null;
let desktopRendersNext = false;
const desktopAttachWaits: string[] = [];
const desktopDetaches = new NodeEvents.EventEmitter();
const desktopEvent = (name: string) =>
  new Promise<void>((resolve) => desktopDetaches.once(name, () => resolve()));
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
const releasedDesktopTabs: Array<string> = [];
const desktopTurns = new NodeEvents.EventEmitter();
const desktopConnections: Array<{ endpoint: string; context: ReturnType<typeof makeContext> }> = [];
let nativeHandler: DesktopChannel.DesktopPrivateEntryHandler | undefined;
let nativeReplyWaiter: ((response: DesktopBrowserPrivateEntryResponse) => void) | undefined;
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.die("mock Chromium does not need an executable"),
    installed: Effect.die("mock Chromium does not need an executable"),
  }),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: true,
    registerPrivateEntryHandler: (handler) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          nativeHandler = handler;
        }),
        () =>
          Effect.sync(() => {
            nativeHandler = undefined;
          }),
      ),
    isCurrentPrivateEntryAttachment: (target) =>
      Effect.sync(
        () =>
          desktopTabs.has(target.tabId) &&
          target.channelEpoch === "native-channel" &&
          target.attachmentId === "native-attachment",
      ),
    sendPrivateEntry: (response) =>
      Effect.sync(() => {
        const waiter = nativeReplyWaiter;
        nativeReplyWaiter = undefined;
        waiter?.(response);
        return true;
      }),
    awaitAttached: (key) =>
      Effect.sync(() => {
        desktopAttachWaits.push(key.tabId);
        return desktopRenders(key.tabId);
      }),
    detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onDetach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("detach", onDetach);
          desktopDetaches.emit("detach-ready");
          return onDetach;
        }),
        (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
      ),
    ),
    attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onAttach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("attach", onAttach);
          desktopDetaches.emit("attach-ready");
          return onAttach;
        }),
        (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
      ),
    ),
    isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    endpoint: (key) =>
      Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
        Effect.sync(() => {
          releasedDesktopTabs.push(key.tabId);
          desktopDetaches.emit("released");
        }),
      ),
    pointer: () => Effect.void,
    turn: (threadId, active) => Effect.sync(() => desktopTurns.emit("turn", threadId, active)),
  }),
  PreviewAgentActivity.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-browser-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { browser, broker, tabId };
});
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

beforeEach(() => {
  nativeHandler = undefined;
  nativeReplyWaiter = undefined;
  contexts.length = 0;
  encoderStreams.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  contextFailure = null;
  initialNavigation = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  desktopRendersNext = false;
  desktopAttachWaits.length = 0;
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});

it.live("hidden agent tabs retain the desktop handshake and agent ownership", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      // The renderer may attach after manager.open. Do not race it with a second
      // independently stateful browser page that the user would not be viewing.
      expect(desktopAttachWaits).toContain(tabId);
      expect(contexts).toHaveLength(1);
      expect(desktopConnections).toHaveLength(0);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.control?.owner).toBe("agent");
      expect(status.control?.ownedByCaller).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("visible user tabs retain their desktop attach wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        runtime: "server",
        reveal: true,
      });
      yield* browser.attachViewer(viewerInput(opened.tabId, false));
      expect(desktopAttachWaits).toContain(opened.tabId);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "a confirmed challenge stops agent mutations and new tabs but leaves snapshots readable until human release",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        page.emit("response", {
          url: () => "http://localhost/challenge",
          status: () => 403,
          headers: () => ({ "cf-mitigated": "challenge" }),
          request: () => ({
            isNavigationRequest: () => true,
            frame: () => page,
            method: () => "GET",
          }),
        });
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.control?.owner).toBe("human");
        yield* broker.invoke({ scope, tabId, operation: "snapshot", input: {} });
        for (const operation of ["evaluate", "navigate", "click", "open", "close"] as const) {
          const refused = yield* broker
            .invoke<void>({ scope, tabId, operation, input: {} })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({ reason: "humanControl" });
        }
        const laterClose = () =>
          broker
            .invoke<void>({ scope: asSession("agent-b"), tabId, operation: "close", input: {} })
            .pipe(Effect.flip);
        expect(yield* laterClose()).toMatchObject({ reason: "humanControl" });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const disconnected = yield* browser.attachViewer(viewerInput(tabId, true));
            yield* disconnected.input({ type: "takeControl" });
          }),
        );
        expect(yield* laterClose()).toMatchObject({ reason: "humanControl" });
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* viewer.input({ type: "releaseControl" });
        yield* broker.invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "resumed()" },
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "HTTP auth, forbidden and rate-limit responses alone do not become browser challenges",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        for (const status of [401, 403, 429]) {
          page.emit("response", {
            url: () => "http://localhost/result",
            status: () => status,
            headers: () => ({}),
            request: () => ({
              isNavigationRequest: () => true,
              frame: () => page,
              method: () => "GET",
            }),
          });
        }
        yield* broker.invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "normal()" },
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a recognized challenge frame pauses the attached desktop path as well", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { browser, broker, tabId } = yield* ready;
      const page = desktopConnections[0]!.context.page;
      page.emit(
        "framenavigated",
        makeFrame("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget"),
      );
      yield* broker.invoke({ scope, tabId, operation: "snapshot", input: {} });
      expect(
        yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: {} })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "humanControl" });
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "releaseControl" });
      yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: "resumed()" },
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("tells the desktop once per thread when its agent turns start and end", () =>
  Effect.gen(function* () {
    yield* ServerBrowser.ServerBrowser;
    const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
    const threadId = scope.thread.threadId;
    const turns = yield* Queue.unbounded<readonly [string, boolean]>();
    const record = (id: string, active: boolean) => Queue.offerUnsafe(turns, [id, active]);
    desktopTurns.on("turn", record);
    yield* Effect.addFinalizer(() => Effect.sync(() => desktopTurns.off("turn", record)));
    const endFirst = yield* activity.begin(threadId);
    // An overlapping turn on the same thread neither starts nor ends focus on its own.
    const endSecond = yield* activity.begin(threadId);
    expect(yield* Queue.take(turns)).toEqual([threadId, true]);
    yield* endFirst;
    yield* endFirst;
    expect(yield* activity.active(threadId)).toBe(true);
    yield* endSecond;
    expect(yield* Queue.take(turns)).toEqual([threadId, false]);
    expect(yield* Queue.size(turns)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("preview_open reports its navigation timeout instead of the request budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      initialNavigation = async () => {
        throw Object.assign(new Error("page.goto: Timeout 15000ms exceeded."), {
          name: "TimeoutError",
        });
      };

      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: {
            url: "http://localhost:1337/",
            reuseExistingTab: false,
            show: false,
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        timeoutMs: 15_000,
      });
      expect(error.message).toBe("Preview automation open timed out after 15000ms.");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["desktop" as const, undefined])(
  "explicit desktop targets ($0 runtime) fail without creating a server tab",
  (runtime) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const desktop = yield* manager.open({
          threadId: scope.thread.threadId,
          url: "https://example.com/original",
          ...(runtime === undefined ? {} : { runtime }),
        });
        const before = yield* manager.list({ threadId: scope.thread.threadId });
        const error = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(desktop.tabId),
            operation: "open",
            input: { url: "https://example.com/replacement", open: true },
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
        expect(error.message).toContain("desktop runtime");
        expect(error.message).toContain("cannot control");
        expect(yield* manager.list({ threadId: scope.thread.threadId })).toEqual(before);
        expect(contexts).toHaveLength(1);
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false },
        });
        expect(reused.tabId).toBe(tabId);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a tab the desktop does not draw is marked headless, so the desktop streams it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      desktopRendersNext = true;
      const desktopTab = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      const headlessOf = (id: string | null) =>
        sessions.find((session) => session.tabId === id)?.headless;

      expect(headlessOf(tabId)).toBe(true);
      expect(headlessOf(desktopTab.tabId)).toBeUndefined();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://10.255.255.1/" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("a pending viewer $method allows a corrected URL and text input", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const page = contexts[0]!.page;
      page[method].mockImplementationOnce(() => {
        started.resolve();
        return committed.promise;
      });
      const navigation = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      const typed = Promise.withResolvers<void>();
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") typed.resolve();
        return send(operation, input);
      });
      const correction = yield* Effect.gen(function* () {
        yield* viewer.input({ type: "navigate", url: "http://localhost:5173/fixed" });
        yield* viewer.input({ type: "text", text: "hello" });
      }).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      // The text reaches the page while the first navigation is still uncommitted.
      yield* Effect.promise(() => typed.promise);
      expect(page.goto).toHaveBeenLastCalledWith(
        "http://localhost:5173/fixed",
        expect.objectContaining({ waitUntil: "commit" }),
      );
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "hello",
      });
      committed.resolve();
      yield* Fiber.join(navigation);
      yield* Fiber.join(correction);
    }),
  ).pipe(Effect.provide(layer)),
);

// The fake encoder decodes every frame at 1280x800, so 30 fps hits the bitrate floor.
it.live.each([
  { reports: [], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [30], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [60], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, undefined], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, 30], frameRate: 30, bitsPerSecond: 2.5e6 },
] satisfies ReadonlyArray<{
  reports: ReadonlyArray<BrowserRecordingFrameRate | undefined>;
  frameRate: number;
  bitsPerSecond: number;
}>)(
  "agent recordings encode at the last reported frame rate ($reports)",
  ({ reports, frameRate, bitsPerSecond }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        for (const recordingFrameRate of reports) {
          yield* browser.reportProfiles({
            profiles: [],
            defaultProfileId: "default",
            ...(recordingFrameRate === undefined ? {} : { recordingFrameRate }),
          });
        }
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        expect(encoderStreams).toEqual([{ frameRate, bitsPerSecond }]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("enforces provider ownership and explicit targets when a session has multiple tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/foreign" },
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(
        "http://localhost:5173/foreign",
        expect.anything(),
      );
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope: asSession("agent-b"),
        tabId,
        operation: "snapshot",
        input: {},
      });
      const foreignEvaluate = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "evaluate",
          input: { expression: "read()" },
        })
        .pipe(Effect.flip);
      expect(foreignEvaluate).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      yield* broker.invoke({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const ambiguous = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "ambiguous()" } })
        .pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const ambiguousStop = yield* broker
        .invoke<void>({ scope, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(ambiguousStop).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const explicitStop = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(explicitStop).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
      });
      const result = yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: "owned()" },
      });
      expect(result).toBe("evaluated");
      expect(contexts).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "a later session of the same thread can close old agent tabs unless a human controls them (desktop: %s)",
  (desktop) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = desktop;
        const { browser, broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const later = asSession("agent-b");
        const before = yield* broker.invoke<PreviewAutomationStatus>({
          scope: later,
          tabId,
          operation: "status",
          input: {},
        });
        expect(before.control).toMatchObject({ owner: "agent", ownedByCaller: false });
        const otherThread = {
          ...later,
          thread: { ...later.thread, threadId: ThreadId.make("other-thread") },
        };
        const foreign = yield* broker
          .invoke<void>({ scope: otherThread, tabId, operation: "close", input: {} })
          .pipe(Effect.flip);
        expect(foreign).toMatchObject({ _tag: "PreviewAutomationTabNotFoundError" });
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const controlled = yield* broker
          .invoke<void>({ scope: later, tabId, operation: "close", input: {} })
          .pipe(Effect.flip);
        expect(controlled).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        yield* viewer.input({ type: "releaseControl" });
        yield* broker.invoke({ scope: later, tabId, operation: "close", input: {} });
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        expect(sessions.some((session) => session.tabId === tabId)).toBe(false);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("inspects the existing controlled page without clicking and refuses other viewers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const target = {
        tagName: "button",
        selector: "#save",
        htmlPreview: "<button id=save>Save</button>",
        styles: "display: block",
        rect: { x: 10, y: 20, width: 30, height: 40 },
      };
      const dispose = vi.fn(async () => {});
      const evaluateHandle = vi.fn(async () => ({
        asElement: () => ({
          contentFrame: async () => null,
          evaluate: async () => target,
        }),
        dispose,
      }));
      Object.assign(page, { evaluateHandle });
      const readonly = yield* browser.attachViewer(viewerInput(tabId, false));
      yield* readonly.input({ type: "inspect", requestId: "no-access", x: 15, y: 25 });
      expect(evaluateHandle).not.toHaveBeenCalled();
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* Queue.clear(viewer.output);
      const session = contexts[0]!.sessions.at(-1)!;
      session.send.mockClear();
      yield* viewer.input({ type: "inspect", requestId: "selected", x: 15, y: 25 });
      const outputs = yield* Queue.takeAll(viewer.output);
      expect(outputs).toContainEqual(
        expect.objectContaining({
          _tag: "selection",
          requestId: "selected",
          annotation: expect.objectContaining({
            comment: "",
            screenshot: null,
            elements: [
              expect.objectContaining({ element: expect.objectContaining({ selector: "#save" }) }),
            ],
          }),
        }),
      );
      expect(dispose).toHaveBeenCalledOnce();
      expect(session.send.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
      evaluateHandle.mockRejectedValueOnce(new Error("inspection evaluation failed"));
      yield* viewer.input({ type: "inspect", requestId: "failed-evaluation", x: 15, y: 25 });
      expect(yield* Queue.takeAll(viewer.output)).toContainEqual({
        _tag: "selection",
        requestId: "failed-evaluation",
        annotation: null,
        failed: true,
      });
      yield* viewer.input({ type: "inspect", requestId: "invalid", x: Number.NaN, y: 25 });
      yield* viewer.input({ type: "releaseControl" });
      yield* viewer.input({ type: "inspect", requestId: "released", x: 15, y: 25 });
      expect(evaluateHandle).toHaveBeenCalledTimes(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("streams to a read-only viewer without allowing takeover, input, or viewport changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const page = contexts[0]!.page;
      page.setViewportSize.mockClear();
      const session = contexts[0]!.sessions.at(-1)!;
      session.send.mockClear();
      for (const message of [
        { type: "takeControl" },
        { type: "inspect", requestId: "readonly", x: 5, y: 5 },
        { type: "key", action: "down", key: "a", text: "a" },
        { type: "resize", width: 390, height: 844 },
        { type: "viewport", setting: { _tag: "freeform", width: 390, height: 844 } },
      ])
        yield* viewer.input(message);
      expect(page.setViewportSize).not.toHaveBeenCalled();
      expect(session.send.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
      const outputs = yield* Queue.takeAll(viewer.output);
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "frame", data: Buffer.from("frame") }),
      );
      expect(outputs).toContainEqual(expect.objectContaining({ _tag: "viewport" }));
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "control", canOperate: false, controller: "agent" }),
      );
      const operator = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* operator.input({ type: "takeControl" });
      yield* operator.input({ type: "text", text: "typed" });
      yield* operator.input({ type: "resize", width: 390, height: 844 });
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "typed",
      });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      yield* operator.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover waits for the running agent and revokes snapshot refs before returning control",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const ref = /\[ref=([^\]]+)\]/.exec(String(snapshot.accessibilityTree))![1]!;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<Record<string, unknown>>();
        const session = contexts[0]!.sessions[0]!;
        session.send.mockImplementationOnce(async () => {
          started.resolve();
          return finish.promise;
        });
        const running = yield* broker
          .invoke({ scope, tabId, operation: "evaluate", input: { expression: "pending()" } })
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => finish.resolve({ result: { value: "finished" } })),
        );
        yield* Effect.promise(() => started.promise);
        const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
        let control = yield* Queue.take(viewer.output);
        while (control._tag !== "control" || control.controller !== "you") {
          control = yield* Queue.take(viewer.output);
        }
        const rejected = yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "racing()" } })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        finish.resolve({ result: { value: "finished" } });
        expect(yield* Fiber.join(running)).toBe("finished");
        yield* Fiber.join(takeover);
        yield* viewer.input({ type: "releaseControl" });
        const stale = yield* broker
          .invoke<void>({ scope, tabId, operation: "click", input: { locator: `aria-ref=${ref}` } })
          .pipe(Effect.flip);
        expect(stale._tag).toBe("PreviewAutomationInvalidSelectorError");
        expect(contexts[0]!.page.locator).not.toHaveBeenCalled();
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "resumed()" },
          }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("reports a pending dialog without evaluating the page and resolves it explicitly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173" },
      });
      const started = Promise.withResolvers<void>();
      const resolvedEvaluation = Promise.withResolvers<Record<string, unknown>>();
      const session = contexts[0]!.sessions[0]!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method !== "Runtime.evaluate") return send(method, input);
        started.resolve();
        return resolvedEvaluation.promise;
      });
      const blockedAction = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete row?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => resolvedEvaluation.resolve({ result: { value: true } })),
      );
      yield* Effect.promise(() => started.promise);
      const dialog = {
        type: () => "confirm",
        message: () => "Delete row?",
        defaultValue: () => "",
        accept: vi.fn(async () => {
          resolvedEvaluation.resolve({ result: { value: true } });
        }),
        dismiss: vi.fn(async () => {}),
      };
      page.emit("dialog", dialog);
      page.title.mockClear();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.dialog).toMatchObject({ type: "confirm", message: "Delete row?" });
      expect(page.title).not.toHaveBeenCalled();
      expect(dialog.dismiss).not.toHaveBeenCalled();
      const reuse = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "open",
          input: { url: "http://localhost:5173/other" },
        })
        .pipe(Effect.flip);
      expect(reuse).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "dialogPending",
      });
      expect(page.goto).toHaveBeenCalledTimes(1);
      yield* broker.invoke({ scope, tabId, operation: "dialog", input: { accept: true } });
      expect(yield* Fiber.join(blockedAction)).toBe(true);
      expect(dialog.accept).toHaveBeenCalledTimes(1);
      const resolved = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(resolved.dialog).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a tab opened to a file the browser cannot show reports the file to download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const request = { url: () => pdf, method: () => "GET", isNavigationRequest: () => true };
      page.emit("requestfailed", {
        ...request,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        delete: async () => {
          // A new navigation during cleanup must not erase the settled download status.
          page.emit("request", {
            url: () => "https://example.com/next",
            method: () => "GET",
            isNavigationRequest: () => true,
            frame: () => page,
          });
        },
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      written.resolve();
      const received = [];
      let status;
      do {
        status = yield* PubSub.take(events);
        received.push(status);
      } while (
        status.type !== "navigated" ||
        status.snapshot.navStatus._tag !== "Loading" ||
        status.snapshot.navStatus.url !== "https://example.com/next"
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "failed",
          url: pdf,
          download: { id: expect.any(String), fileName: "paper.pdf" },
        }),
      );
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "a late failure from a request that predates tracking leaves a newer navigation loading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const navigation = (url: string) => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => page,
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        });
        page.emit("request", navigation("https://example.com/next"));
        // A popup's first request can start before the tab listens for requests.
        page.emit("requestfailed", navigation("https://example.com/first"));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.loading).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("only the controlling viewer's copy and cut keys reach its clipboard", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      pageCopy = "unprompted";
      yield* viewer.input({ type: "mouse", action: "move", x: 10, y: 10 });
      yield* viewer.input({ type: "wheel", x: 10, y: 10, deltaY: 40 });
      yield* viewer.input({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
      yield* viewer.input({ type: "unknown" });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      keyCopy = "copied";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      keyCopy = "cut";
      yield* viewer.input({ type: "key", action: "down", key: "x", code: "KeyX", modifiers: 2 });
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "cut" }]);
      pageCopy = "left over";
      keyCopy = "";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "a page download is saved, offered to the controller, and listed for the agent (delete fails: %s)",
  (deleteFails) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* Queue.clear(viewer.output);
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        const released = Promise.withResolvers<void>();
        page.emit("download", {
          failure: async () => null,
          delete: async () => {
            try {
              if (deleteFails) throw new Error("context closed");
              await NodeFSP.rm(original);
            } finally {
              released.resolve();
            }
          },
          saveAs: (path: string) => NodeFSP.copyFile(original, path),
          suggestedFilename: () => "report.csv",
          url: () => 'data:text/csv;charset="a,b",a b\'c',
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
        expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(deleteFails);
        const file = yield* browser.openDownload({
          threadId: scope.thread.threadId,
          tabId,
          downloadId: offered.id,
        });
        expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
        expect(yield* fs.readFileString(Option.getOrThrow(file).path)).toBe("a,b");
        if ((yield* HostProcess.Platform) !== "win32") {
          expect((yield* fs.stat(Option.getOrThrow(file).path)).mode & 0o777).toBe(0o600);
        }
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([
          expect.objectContaining({
            fileName: "report.csv",
            sizeBytes: 3,
            url: "data:text/csv,…",
          }),
        ]);
        expect(
          Option.isNone(
            yield* browser.openDownload({
              threadId: scope.thread.threadId,
              tabId,
              downloadId: "guess",
            }),
          ),
        ).toBe(true);
        if ((yield* HostProcess.Platform) !== "win32") {
          const folder = (yield* Path.Path).dirname(Option.getOrThrow(file).path);
          yield* fs.chmod(folder, 0o755);
          page.emit("download", {
            failure: async () => null,
            delete: async () => {},
            saveAs: (path: string) => NodeFSP.writeFile(path, "c"),
            suggestedFilename: () => "again.csv",
            url: () => "https://example.test/again.csv",
          });
          let again = yield* Queue.take(viewer.output);
          while (again._tag !== "download") again = yield* Queue.take(viewer.output);
          expect((yield* fs.stat(folder)).mode & 0o777).toBe(0o700);
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["save failed", "oversized"])(
  "a rejected download releases the original and keeps no saved copy (%s)",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        let savedPath: string | undefined;
        const released = Promise.withResolvers<void>();
        contexts[0]!.page.emit("download", {
          failure: async () => null,
          delete: async () => {
            await NodeFSP.rm(original);
            released.resolve();
          },
          saveAs: async (path: string) => {
            savedPath = path;
            await NodeFSP.copyFile(original, path);
            if (outcome === "save failed") throw new Error("save interrupted");
            // A sparse file exercises the size limit without writing a GiB of data.
            await NodeFSP.truncate(path, 1024 ** 3 + 1);
          },
          suggestedFilename: () => "report.csv",
          url: () => "blob:http://localhost:5173/1",
        });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(false);
        if (savedPath !== undefined) expect(yield* fs.exists(savedPath)).toBe(false);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a page's file picker goes to the controller and takes its uploaded files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
        setFiles,
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ multiple: false, accept: ".csv" });
      const file = (name: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(name) });
      const answer = (chooserId: string) =>
        browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId,
          files: [file("a.csv"), file("b.csv")],
        });
      expect(yield* answer("other")).toBe(false);
      expect(yield* answer(offered.id)).toBe(true);
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the current controller can answer a file picker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      contexts[0]!.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => "" }),
        setFiles,
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      const answered = yield* browser.answerFileChooser({
        threadId: scope.thread.threadId,
        tabId,
        chooserId: offered.id,
        files: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }],
      });
      expect(answered).toBe(false);
      expect(setFiles).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("agents read a human's tab with no arguments and act on it only while nobody drives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        url: "http://localhost:5173/mine",
        runtime: "server",
      });
      const tabId = PreviewTabId.make(opened.tabId);
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        tabId,
        control: { owner: "human", ownedByCaller: false },
      });
      expect(status.tabs).toEqual([
        expect.objectContaining({ tabId, owner: "human", ownedByCaller: false, visible: true }),
      ]);
      const evaluated = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "read()" } })
        .pipe(Effect.flip);
      expect(evaluated).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      const refused = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/agent" },
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* viewer.input({ type: "releaseControl" });
      const released = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(released.control).toMatchObject({ owner: "unclaimed", ownedByCaller: false });
      for (const caller of [scope, asSession("agent-b")]) {
        const refusedClose = yield* broker
          .invoke<void>({ scope: caller, tabId, operation: "close", input: {} })
          .pipe(Effect.flip);
        expect(refusedClose).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "agentMismatch",
        });
      }
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/agent" },
      });
      expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
        "http://localhost:5173/agent",
        expect.anything(),
      );
      yield* viewer.input({ type: "takeControl" });
      const retaken = yield* broker
        .invoke<void>({ scope, tabId, operation: "press", input: { key: "Enter" } })
        .pipe(Effect.flip);
      expect(retaken).toMatchObject({ reason: "humanControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a session's own tab stays its default while other sessions' tabs are listed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const other = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabId).toBe(tabId);
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId, owner: "agent", ownedByCaller: true }),
          expect.objectContaining({ tabId: other.tabId, owner: "agent", ownedByCaller: false }),
        ]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "preview_open picks a reported profile by id or name and defaults to the reported one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        yield* browser.reportProfiles({
          profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
          defaultProfileId: "profile-work",
        });
        const openWith = (profileId?: string) =>
          broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: {
              reuseExistingTab: false,
              show: false,
              ...(profileId === undefined ? {} : { profileId }),
            },
          });
        const byDefault = yield* openWith();
        const byName = yield* openWith("WORK");
        const byId = yield* openWith("incognito");
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        const profileOf = (tabId: string | null) =>
          sessions.find((session) => session.tabId === tabId)?.profileId;
        expect(profileOf(byDefault.tabId)).toBe("profile-work");
        expect(profileOf(byName.tabId)).toBe("profile-work");
        expect(profileOf(byId.tabId)).toBe("incognito");
        expect(contextRequests).toEqual([
          { profileId: "profile-work", isolated: false },
          { profileId: "profile-work", isolated: false },
          { profileId: "incognito", isolated: true },
        ]);
        expect(byDefault).toMatchObject({
          defaultProfileId: "profile-work",
          profiles: [
            { id: "default", name: "Default" },
            { id: "incognito", name: "Incognito", incognito: true },
            { id: "profile-work", name: "Work" },
          ],
        });
        const unknown = yield* openWith("Personal").pipe(Effect.flip);
        expect(unknown).toMatchObject({
          _tag: "PreviewAutomationExecutionError",
          reason:
            'No browser profile is named "Personal". Use one of: Default (id default), Incognito (id incognito), Work (id profile-work).',
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an agent tab keeps throwaway storage when no client reported profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      expect(contextRequests).toEqual([{ profileId: "default", isolated: true }]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop page that comes back reconnects without waiting for a viewer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      yield* ServerBrowser.ServerBrowser;
      const connected = desktopEvent("connected");
      const detachReady =
        desktopDetaches.listenerCount("detach") === 0 ? desktopEvent("detach-ready") : undefined;
      const attachReady =
        desktopDetaches.listenerCount("attach") === 0 ? desktopEvent("attach-ready") : undefined;
      if (detachReady !== undefined) yield* Effect.promise(() => detachReady);
      if (attachReady !== undefined) yield* Effect.promise(() => attachReady);
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      yield* Effect.promise(() => connected);
      yield* Effect.promise(() => desktopConnections[0]!.context.registered);
      const released = desktopEvent("released");
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      yield* Effect.promise(() => released);
      const reconnected = desktopEvent("connected");
      desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      yield* Effect.promise(() => reconnected);
      yield* Effect.promise(() => desktopConnections[1]!.context.registered);
      expect(desktopConnections).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "native human fill reserves a human-opened primary tab and refuses an existing auto-taken viewer",
  () =>
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      // Observation alone constructs the real ServerTab without claiming its human control.
      yield* browser.attachViewer(viewerInput(opened.tabId, false));
      const binding = {
        threadId: scope.thread.threadId,
        tabId: opened.tabId,
        channelEpoch: "native-channel",
        attachmentId: "native-attachment",
        requestId: "native-acquire",
      };
      const next = () => {
        const pending = Promise.withResolvers<DesktopBrowserPrivateEntryResponse>();
        nativeReplyWaiter = pending.resolve;
        return pending.promise;
      };
      const acquisition = next();
      yield* nativeHandler!.request({ ...binding, type: "private-entry-acquire" });
      const grant = yield* Effect.promise(() => acquisition);
      expect(grant.type).toBe("private-entry-granted");
      if (grant.type !== "private-entry-granted") throw new Error("Expected native grant");
      const releasing = next();
      yield* nativeHandler!.request({
        ...binding,
        type: "private-entry-release",
        requestId: "native-release",
        leaseId: grant.leaseId,
        generation: grant.generation,
      });
      expect(yield* Effect.promise(() => releasing)).toMatchObject({
        type: "private-entry-released",
        requestId: "native-release",
        generation: grant.generation,
      });
      // The existing viewer path REALLY auto-takes an unclaimed human tab.
      yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const refusal = next();
      yield* nativeHandler!.request({
        ...binding,
        type: "private-entry-acquire",
        requestId: "must-not-impersonate-viewer",
      });
      expect(yield* Effect.promise(() => refusal)).toMatchObject({
        type: "private-entry-refused",
        reason: "viewer-owned",
      });
    }).pipe(Effect.provide(layer), Effect.scoped),
);

function nativeAuthorityFixture(
  body: (fixture: {
    router: Effect.Success<ReturnType<typeof DesktopChannel.makePrivateEntryRouter>>;
    control: SessionControl;
    responses: Queue.Queue<DesktopBrowserPrivateEntryResponse>;
    target: {
      threadId: string;
      tabId: string;
      channelEpoch: string;
      attachmentId: string;
      requestId: string;
    };
    tab: { control: SessionControl; desktop: object | null; closing: boolean };
  }) => Effect.Effect<void>,
  agentId: string | null = null,
) {
  return Effect.gen(function* () {
    const responses = yield* Queue.unbounded<DesktopBrowserPrivateEntryResponse>();
    const router = yield* DesktopChannel.makePrivateEntryRouter((response) =>
      Queue.offer(responses, response).pipe(Effect.as(true)),
    );
    const target = {
      threadId: "native-thread",
      tabId: "native-tab",
      channelEpoch: "native-epoch",
      attachmentId: "native-incarnation",
      requestId: "acquire-a",
    };
    let changed = () => {};
    const control = new SessionControl(agentId, () => changed());
    const tab = { control, desktop: {} as object | null, closing: false };
    const authority = yield* ServerBrowser.makeDesktopPrivateEntryAuthority(router, () => tab);
    changed = () => authority.controlChanged(target);
    yield* router.attach(target, target);
    yield* body({ router, control, responses, target, tab });
  }).pipe(Effect.scoped);
}

it.live(
  "native reservation drains current work and invalidates queued agent actions before grant",
  () =>
    nativeAuthorityFixture(({ router, control, responses, target }) =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>();
        const drain = Promise.withResolvers<void>();
        const running = control.agent("permitted-on-human-tab", async () => {
          started.resolve();
          await drain.promise;
        });
        yield* Effect.promise(() => started.promise);
        const queued = control
          .agent("permitted-on-human-tab", async () => "must-not-run")
          .then(
            () => true,
            () => false,
          );
        yield* router.receive({ ...target, type: "private-entry-acquire" });
        expect(control.controller).toMatch(/^native-private-entry:/);
        expect(yield* Queue.clear(responses)).toEqual([]);
        drain.resolve();
        yield* Effect.promise(() => running);
        expect(yield* Effect.promise(() => queued)).toBe(false);
        const grant = yield* Queue.take(responses);
        expect(grant.type).toBe("private-entry-granted");
        expect(grant).toMatchObject({ generation: control.generation, ...target });
      }),
    ),
);

it.live(
  "native reservation refuses agent provenance, other human, headless and unknown attachment",
  () =>
    Effect.gen(function* () {
      yield* nativeAuthorityFixture(
        ({ router, target, responses }) =>
          Effect.gen(function* () {
            yield* router.receive({ ...target, type: "private-entry-acquire" });
            expect(yield* Queue.take(responses)).toMatchObject({
              type: "private-entry-refused",
              reason: "agent-owned",
            });
          }),
        "agent-owner",
      );
      yield* nativeAuthorityFixture(({ router, control, target, responses, tab }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => control.take("actual-other-viewer"));
          yield* router.receive({ ...target, type: "private-entry-acquire" });
          expect(yield* Queue.take(responses)).toMatchObject({
            type: "private-entry-refused",
            reason: "viewer-owned",
          });
          yield* Effect.promise(() => control.release("actual-other-viewer"));
          tab.desktop = null;
          yield* router.receive({ ...target, type: "private-entry-acquire" });
          expect(yield* Queue.take(responses)).toMatchObject({
            type: "private-entry-refused",
            reason: "unavailable",
          });
          yield* router.receive({
            ...target,
            attachmentId: "unknown",
            type: "private-entry-acquire",
          });
          expect(yield* Queue.take(responses)).toMatchObject({
            type: "private-entry-refused",
            reason: "stale",
          });
        }),
      );
    }),
);

it.live("cancelled acquisition and detach during drain never produce a late native grant", () =>
  nativeAuthorityFixture(({ router, control, target, responses }) =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const drain = Promise.withResolvers<void>();
      const running = control.agent("agent", async () => {
        started.resolve();
        await drain.promise;
      });
      yield* Effect.promise(() => started.promise);
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      yield* router.receive({ ...target, type: "private-entry-cancel" });
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-revoked",
        reason: "cancelled",
        requestId: target.requestId,
      });
      yield* router.detach(target, target);
      drain.resolve();
      yield* Effect.promise(() => running);
      expect(control.controller).toBeNull();
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-refused",
        reason: "stale",
      });
      expect(
        (yield* Queue.clear(responses)).some(
          (response) => response.type === "private-entry-granted",
        ),
      ).toBe(false);
    }),
  ),
);

it.live("native release uses its own request ID and cannot release the wrong lease", () =>
  nativeAuthorityFixture(({ router, control, target, responses }) =>
    Effect.gen(function* () {
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      const grant = yield* Queue.take(responses);
      if (grant.type !== "private-entry-granted") throw new Error("Expected grant");
      yield* router.receive({
        ...target,
        type: "private-entry-release",
        requestId: "wrong-release",
        leaseId: "wrong",
        generation: grant.generation,
      });
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-refused",
        reason: "stale",
      });
      expect(control.controller).not.toBeNull();
      yield* router.receive({
        ...target,
        type: "private-entry-release",
        requestId: "wrong-generation",
        leaseId: grant.leaseId,
        generation: grant.generation + 1,
      });
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-refused",
        reason: "stale",
      });
      expect(control.controller).not.toBeNull();
      yield* router.receive({
        ...target,
        type: "private-entry-release",
        requestId: "release-new-id",
        leaseId: grant.leaseId,
        generation: grant.generation,
      });
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-released",
        requestId: "release-new-id",
        leaseId: grant.leaseId,
        generation: grant.generation,
      });
      expect(control.controller).toBeNull();
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-refused",
        reason: "cancelled",
      });
    }),
  ),
);

it.live(
  "attachment replacement revokes old reservation and old cancel cannot touch its successor",
  () =>
    nativeAuthorityFixture(({ router, control, target, responses }) =>
      Effect.gen(function* () {
        yield* router.receive({ ...target, type: "private-entry-acquire" });
        const original = yield* Queue.take(responses);
        expect(original.type).toBe("private-entry-granted");
        const replacement = {
          ...target,
          channelEpoch: "replacement-channel",
          attachmentId: "replacement-document",
          requestId: "replacement-acquire",
        };
        yield* router.attach(replacement, replacement);
        expect(yield* Queue.take(responses)).toMatchObject({
          type: "private-entry-revoked",
          reason: "detached",
          requestId: target.requestId,
        });
        expect(control.controller).toBeNull();
        yield* router.receive({ ...replacement, type: "private-entry-acquire" });
        const grant = yield* Queue.take(responses);
        expect(grant.type).toBe("private-entry-granted");
        const owner = control.controller;
        yield* router.receive({ ...target, type: "private-entry-cancel" });
        expect(yield* Queue.take(responses)).toMatchObject({
          type: "private-entry-refused",
          reason: "stale",
        });
        expect(control.controller).toBe(owner);
        yield* router.close;
        expect(control.controller).toBeNull();
      }),
    ),
);

it.live("owner loss during acquisition drain revokes before a grant", () =>
  nativeAuthorityFixture(({ router, control, target, responses }) =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const drain = Promise.withResolvers<void>();
      const running = control.agent("agent", async () => {
        started.resolve();
        await drain.promise;
      });
      yield* Effect.promise(() => started.promise);
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      const owner = control.controller!;
      const release = control.release(owner);
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-revoked",
        reason: "control-changed",
      });
      drain.resolve();
      yield* Effect.promise(() => running);
      yield* Effect.promise(() => release);
      expect(control.controller).toBeNull();
      expect(
        (yield* Queue.clear(responses)).some(
          (response) => response.type === "private-entry-granted",
        ),
      ).toBe(false);
    }),
  ),
);

it.live("cancel during release drain cannot produce a release ACK that resumes native fill", () =>
  nativeAuthorityFixture(({ router, control, target, responses }) =>
    Effect.gen(function* () {
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      const grant = yield* Queue.take(responses);
      if (grant.type !== "private-entry-granted") throw new Error("Expected grant");
      const started = Promise.withResolvers<void>();
      const drain = Promise.withResolvers<void>();
      const running = control.system(async () => {
        started.resolve();
        await drain.promise;
      });
      yield* Effect.promise(() => started.promise);
      yield* router.receive({
        ...target,
        type: "private-entry-release",
        requestId: "release",
        leaseId: grant.leaseId,
        generation: grant.generation,
      });
      yield* router.receive({ ...target, type: "private-entry-cancel" });
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-revoked",
        reason: "cancelled",
        requestId: target.requestId,
      });
      drain.resolve();
      yield* Effect.promise(() => running);
      expect(
        (yield* Queue.clear(responses)).some(
          (response) => response.type === "private-entry-released",
        ),
      ).toBe(false);
    }),
  ),
);

it.live("a repeated acquisition shares its lease and a tab close revokes exactly that lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const responses = yield* Queue.unbounded<DesktopBrowserPrivateEntryResponse>();
      const router = yield* DesktopChannel.makePrivateEntryRouter((response) =>
        Queue.offer(responses, response).pipe(Effect.as(true)),
      );
      const target = {
        threadId: "thread",
        tabId: "tab",
        channelEpoch: "channel",
        attachmentId: "attachment",
        requestId: "acquire",
      };
      let changed = () => {};
      const control = new SessionControl(null, () => changed());
      const tab = { control, desktop: {}, closing: false };
      const authority = yield* ServerBrowser.makeDesktopPrivateEntryAuthority(router, () => tab);
      changed = () => authority.controlChanged(target);
      yield* router.attach(target, target);
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      const grant = yield* Queue.take(responses);
      expect(grant.type).toBe("private-entry-granted");
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      expect(yield* Queue.take(responses)).toEqual(grant);
      tab.closing = true;
      yield* authority.closeTab(target);
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-revoked",
        reason: "closed",
      });
      expect(control.controller).toBeNull();
      yield* router.receive({ ...target, requestId: "after-close", type: "private-entry-acquire" });
      expect(yield* Queue.take(responses)).toMatchObject({
        type: "private-entry-refused",
        reason: "unavailable",
      });
    }),
  ),
);

it.live("an undeliverable grant releases the actual SessionControl reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const revoked = yield* Deferred.make<DesktopBrowserPrivateEntryResponse>();
      const router = yield* DesktopChannel.makePrivateEntryRouter((response) => {
        if (response.type === "private-entry-granted") return Effect.succeed(false);
        return Deferred.succeed(revoked, response).pipe(Effect.as(true));
      });
      const target = {
        threadId: "thread",
        tabId: "tab",
        channelEpoch: "channel",
        attachmentId: "attachment",
        requestId: "acquire",
      };
      let changed = () => {};
      const control = new SessionControl(null, () => changed());
      const tab = { control, desktop: {}, closing: false };
      const authority = yield* ServerBrowser.makeDesktopPrivateEntryAuthority(router, () => tab);
      yield* router.attach(target, target);
      changed = () => authority.controlChanged(target);
      yield* router.receive({ ...target, type: "private-entry-acquire" });
      expect(yield* Deferred.await(revoked)).toMatchObject({
        type: "private-entry-revoked",
        reason: "channel-closed",
      });
      expect(control.controller).toBeNull();
    }),
  ),
);
