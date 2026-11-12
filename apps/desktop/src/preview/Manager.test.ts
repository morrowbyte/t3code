import { it as effectIt } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type {
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewSurfaceFrame,
  DesktopPreviewSurfaceFocusRequest,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
} from "@t3tools/contracts";
import * as NodeVM from "node:vm";
import * as NodeEvents from "node:events";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { PREVIEW_LOCAL_SURFACE_FOCUS_REQUEST_CHANNEL } from "../ipc/channels.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";
import { createOffscreenHost } from "./OffscreenHost.ts";
import * as PreviewPasskeys from "./Passkeys.ts";
import { makeProtonPassProvider } from "./ProtonPassCli.ts";
import { makeAutofill } from "./ProtonPassAutofill.ts";

describe("fitPictureInPictureContentSize", () => {
  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
  });
});

describe("isPreviewEditingShortcut", () => {
  const input = (platform: NodeJS.Platform, key: string, overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key,
      meta: platform === "darwin",
      control: platform !== "darwin",
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes macOS Paste and Match Style when Option changes the key to a symbol", () => {
    const pasteAndMatchStyle = input("darwin", "◊", { code: "KeyV", alt: true, shift: true });
    expect(PreviewManager.isPreviewEditingShortcut(pasteAndMatchStyle, "darwin")).toBe(true);
    for (const modifiers of [
      { code: "KeyC" },
      { alt: false },
      { shift: false },
      { control: true },
    ]) {
      expect(
        PreviewManager.isPreviewEditingShortcut({ ...pasteAndMatchStyle, ...modifiers }, "darwin"),
      ).toBe(false);
    }
  });
});

describe("previewWindowOpenAction", () => {
  const details = (overrides: {
    readonly url?: string;
    readonly disposition?: Electron.HandlerDetails["disposition"];
  }) => ({
    url: "https://accounts.google.com/o/oauth2/auth",
    disposition: "new-window" as Electron.HandlerDetails["disposition"],
    ...overrides,
  });

  it("opens a real window for scripted popups so the opener survives", () => {
    expect(PreviewManager.previewWindowOpenAction(details({}))).toBe("popup");
    expect(
      PreviewManager.previewWindowOpenAction(details({ url: "http://localhost:5173/auth" })),
    ).toBe("popup");
  });

  it("opens HTTP links in preview tabs", () => {
    for (const disposition of ["foreground-tab", "background-tab"] as const) {
      expect(PreviewManager.previewWindowOpenAction(details({ disposition }))).toBe("new-tab");
    }
  });

  it("keeps a form POST with a body on the in-place path", () => {
    const postBody = { data: [], contentType: "application/x-www-form-urlencoded" };
    expect(
      PreviewManager.previewWindowOpenAction({
        ...details({ disposition: "foreground-tab" }),
        postBody,
      }),
    ).toBe("navigate");
  });

  it("does not hand a window to schemes that cannot be hardened", () => {
    for (const url of [
      "vscode://vscode-remote/ssh-remote+box/tmp",
      "blob:https://example.com/0b6c6a5e-55d4-4b4c-9d47-8f1b0c1d2e3f",
    ]) {
      expect(PreviewManager.previewWindowOpenAction(details({ url }))).toBe("navigate");
    }
  });

  it("denies local and inline schemes that no page could open in place itself", () => {
    for (const url of [
      "data:text/html,<h1>hi</h1>",
      "DaTa:text/html,<h1>hi</h1>",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "view-source:https://example.com",
      "chrome://gpu",
      "about:srcdoc",
      "devtools://devtools/bundled/inspector.html",
      "filesystem:https://example.com/temporary/page.html",
      "not a url",
    ]) {
      for (const disposition of ["new-window", "foreground-tab", "background-tab"] as const) {
        expect(PreviewManager.previewWindowOpenAction(details({ url, disposition }))).toBe("deny");
      }
    }
  });

  it("denies a blank window instead of blanking the opener", () => {
    for (const url of ["about:blank", ""]) {
      for (const disposition of ["new-window", "foreground-tab"] as const) {
        expect(PreviewManager.previewWindowOpenAction(details({ url, disposition }))).toBe("deny");
      }
    }
  });
});

const {
  browserWindowConstructor,
  clipboardItemConstructor,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  previewSession,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeClipboard,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  clipboardItemConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean; readonly toPNG: () => Buffer } => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from("png"),
  })),
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  previewSession: { on: vi.fn() },
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeClipboard: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  // oxlint-disable-next-line typescript/no-extraneous-class -- This constructor-only mock implements the browser ClipboardItem API.
  ClipboardItem: class {
    constructor(data: Record<string, unknown>) {
      clipboardItemConstructor(data);
    }
  },
  clipboard: {
    write: writeClipboard,
  },
  nativeImage: {
    createFromPath,
  },
  screen: {
    getDisplayMatching: vi.fn(() => ({ scaleFactor: 1 })),
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

const layerBrowserSession = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.succeed(previewSession as unknown as Electron.Session),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const layerEnvironment = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
    dirname: "/tmp/t3/desktop",
    path: {
      join: (...parts: ReadonlyArray<string>) => parts.join("/"),
    },
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

const layerFileSystem = FileSystem.layerNoop({
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
});

const managerLayer = (platform: NodeJS.Platform = "darwin") =>
  PreviewManager.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
        register: () => Effect.void,
        recordMetrics: () => Effect.void,
        shutdown: Effect.void,
      }),
    ),
    Layer.provideMerge(DesktopBrowserHost.layer),
    Layer.provideMerge(layerBrowserSession),
    Layer.provideMerge(
      Layer.mock(PreviewPasskeys.PreviewPasskeys)({
        bridgeEnabled: false,
        installSessionHandlers: () => {},
        attachGuest: () => () => {},
      }),
    ),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(layerFileSystem),
    Layer.provideMerge(Path.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, platform)),
  );

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
    host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
  platform: NodeJS.Platform = "darwin",
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    const host = yield* DesktopBrowserHost.DesktopBrowserHost;
    return yield* use(manager, host);
  }).pipe(Effect.provide(managerLayer(platform)), Effect.scoped);

/** Unit FD peer only: real Host correlation and Manager guards; not real SessionControl acceptance. */
const withAutofillManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
    ready: Deferred.Deferred<void>,
    peer: {
      connection: DesktopBrowserHost.DesktopBrowserConnection;
      releases: Queue.Queue<unknown>;
      cdp: Queue.Queue<string>;
      host: DesktopBrowserHost.DesktopBrowserHost["Service"];
      revoke: Effect.Effect<void>;
    },
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
  options?: { refused?: boolean; holdRelease?: boolean },
) =>
  withManager((manager, host) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const releases = yield* Queue.unbounded<unknown>();
      const cdp = yield* Queue.unbounded<string>();
      const connection = host.createConnection();
      let grant:
        | {
            threadId: string;
            tabId: string;
            channelEpoch: string;
            attachmentId: string;
            requestId: string;
            leaseId: string;
            generation: number;
          }
        | undefined;
      yield* connection.events.pipe(
        Stream.runForEach((line) =>
          Effect.gen(function* () {
            const message = JSON.parse(new TextDecoder().decode(line)) as Record<string, unknown>;
            if (message.type === "cdp" && typeof message.message === "string") {
              yield* Queue.offer(cdp, message.message);
              return;
            }
            if (message.type === "attached") {
              yield* Deferred.succeed(ready, undefined);
              return;
            }
            if (message.type === "private-entry-acquire") {
              if (options?.refused) {
                yield* connection.handleCommandLine(
                  JSON.stringify({
                    ...message,
                    type: "private-entry-refused",
                    reason: "agent-owned",
                  }),
                );
                return;
              }
              const response = {
                ...message,
                type: "private-entry-granted",
                leaseId: "unit-lease",
                generation: 3,
              };
              grant = response as unknown as NonNullable<typeof grant>;
              yield* connection.handleCommandLine(JSON.stringify(response));
            } else if (message.type === "private-entry-release") {
              yield* Queue.offer(releases, message);
              if (!options?.holdRelease)
                yield* connection.handleCommandLine(
                  JSON.stringify({ ...message, type: "private-entry-released" }),
                );
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      return yield* use(manager, ready, {
        connection,
        releases,
        cdp,
        host,
        revoke: Effect.suspend(() =>
          grant
            ? connection.handleCommandLine(
                JSON.stringify({
                  ...grant,
                  type: "private-entry-revoked",
                  reason: "control-changed",
                }),
              )
            : Effect.void,
        ),
      });
    }),
  );

interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly toBitmap?: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

type TestDisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

interface TestHostWebContents {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  readonly isDestroyed: () => boolean;
  readonly session: {
    readonly setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
  };
  readonly displayMediaHandler: () => TestDisplayMediaHandler | undefined;
}

type TestPreviewWebContents = Electron.WebContents & {
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

const makeTestHostWebContents = (): TestHostWebContents => {
  let handler: TestDisplayMediaHandler | undefined;
  return {
    id: 7,
    mainFrame: { frameTreeNodeId: 7 },
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => false,
    session: {
      setDisplayMediaRequestHandler: vi.fn((next: TestDisplayMediaHandler) => {
        handler = next;
      }),
    },
    displayMediaHandler: () => handler,
  };
};

const makeTestPreviewWebContents = (
  capturePage: () => Promise<TestCapturedPreviewImage>,
  id = 42,
  hostWebContents: TestHostWebContents = makeTestHostWebContents(),
) => {
  const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
  return {
    id,
    mainFrame: { routingId: id },
    hostWebContents,
    executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoadingMainFrame: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    setBackgroundThrottling,
    isCurrentlyAudible: () => false,
    on: vi.fn(),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage,
  } as unknown as TestPreviewWebContents;
};

const makeOffscreenFixture = (existingOwner?: Electron.BrowserWindow) => {
  const events = new NodeEvents.EventEmitter();
  const ownerEvents = new NodeEvents.EventEmitter();
  const debuggerEvents = new NodeEvents.EventEmitter();
  let destroyed = false;
  let attached = false;
  let zoomFactor = 1;
  let currentUrl = "about:blank";
  let contentSize = [1, 1];
  const image = (content = "frame") => ({
    getSize: () => ({ width: contentSize[0]!, height: contentSize[1]! }),
    toBitmap: vi.fn(() => Buffer.from(content)),
    toPNG: vi.fn(() => Buffer.from(content)),
    toJPEG: () => Buffer.from(content),
  });
  const capturePage = vi.fn(async () => image());
  const wc = Object.assign(makeTestPreviewWebContents(capturePage), {
    mainFrame: {
      origin: "https://example.com",
      isDestroyed: () => false,
    } as Electron.WebFrameMain,
    session: { getStoragePath: () => "/synthetic/osr-profile" } as Electron.Session,
    isFocused: vi.fn(() => false),
    executeJavaScript: vi.fn<(_script: string) => Promise<unknown>>(async () => ({
      width: 1280,
      height: 720,
    })),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
    hostWebContents: null,
    getType: () => "offscreen",
    getURL: () => currentUrl,
    isDestroyed: () => destroyed,
    isDevToolsOpened: () => false,
    getZoomFactor: () => zoomFactor,
    setZoomFactor: vi.fn((factor: number) => {
      zoomFactor = factor;
    }),
    setFrameRate: vi.fn(),
    startPainting: vi.fn(),
    stopPainting: vi.fn(),
    invalidate: vi.fn(),
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    insertText: vi.fn(async () => {}),
    sendInputEvent: vi.fn(),
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
      }),
      sendCommand: vi.fn(async () => undefined),
      on: debuggerEvents.on.bind(debuggerEvents),
      off: debuggerEvents.off.bind(debuggerEvents),
    },
  });
  const send = vi.fn<(channel: string, frame: DesktopPreviewSurfaceFrame) => void>();
  const focusRequest = vi.fn<(request: DesktopPreviewSurfaceFocusRequest) => void>();
  const ownerFocused = vi.fn(() => true);
  const owner =
    existingOwner ??
    ({
      isDestroyed: () => false,
      isFocused: ownerFocused,
      on: ownerEvents.on.bind(ownerEvents),
      off: ownerEvents.off.bind(ownerEvents),
      once: ownerEvents.once.bind(ownerEvents),
      getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
      webContents: {
        ...makeTestHostWebContents(),
        on: ownerEvents.on.bind(ownerEvents),
        off: ownerEvents.off.bind(ownerEvents),
        send: (
          channel: string,
          payload: DesktopPreviewSurfaceFrame | DesktopPreviewSurfaceFocusRequest,
        ) => {
          if (channel === PREVIEW_LOCAL_SURFACE_FOCUS_REQUEST_CHANNEL && "requestId" in payload) {
            focusRequest(payload);
          } else if ("png" in payload) {
            send(channel, payload);
          }
        },
        setBackgroundThrottling: vi.fn(),
      },
    } as unknown as Electron.BrowserWindow);
  const window = {
    webContents: wc,
    isDestroyed: () => destroyed,
    setContentSize: vi.fn((width: number, height: number) => {
      contentSize = [width, height];
    }),
    getContentSize: () => contentSize,
    destroy: vi.fn(() => {
      destroyed = true;
      events.emit("destroyed");
    }),
  };
  browserWindowConstructor.mockImplementation(function () {
    return window;
  });
  fromId.mockImplementation((id) => (id === wc.id && !destroyed ? wc : null));
  return {
    wc,
    owner,
    window,
    events,
    ownerEvents,
    ownerFocused,
    focusRequest,
    capturePage,
    image,
    send,
    configuration: {
      partition: "persist:t3code-preview-test",
      preload: "/tmp/t3/desktop/preview-pick-preload.cjs",
      viewport: { _tag: "freeform" as const, width: 1440, height: 1700 },
    },
    paint: (content = "frame") => {
      const frame = image(content);
      events.emit("paint", {}, { x: 0, y: 0, width: 1, height: 1 }, frame);
      return frame;
    },
  };
};

const setupRecordingRaceTabs = (manager: PreviewManager.PreviewManager["Service"]) =>
  Effect.gen(function* () {
    const capturePage = vi.fn(async () => ({
      toJPEG: () => Buffer.from("unused-recording-frame"),
      getSize: () => ({ width: 1280, height: 720 }),
    }));
    const host = makeTestHostWebContents();
    const destroyedIds = new Set<number>();
    const makeWebContents = (id: number) =>
      Object.assign(makeTestPreviewWebContents(capturePage, id, host), {
        executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
        isDestroyed: () => destroyedIds.has(id),
      });
    const webContentsById = new Map([
      [41, makeWebContents(41)],
      [42, makeWebContents(42)],
    ]);
    fromId.mockImplementation((id) =>
      id === undefined ? null : (webContentsById.get(id) ?? null),
    );
    yield* manager.createTab("tab_race_a");
    yield* manager.createTab("tab_race_b");
    yield* manager.registerWebview("tab_race_a", 41);
    yield* manager.registerWebview("tab_race_b", 42);
    const grants: Array<{ video?: unknown }> = [];
    return {
      host,
      grants,
      destroy: (id: number) => destroyedIds.add(id),
      takeGrant: (frame = host.mainFrame) =>
        host.displayMediaHandler()?.({ frame }, (value) => {
          grants.push(value);
        }),
    };
  });

const TEST_FAVICON = "data:image/png;base64,cG5n";

const makeSourcePng = (width = 1, height = 1): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const makeFaviconWebContents = (options?: {
  readonly changes?: ChangeSignal;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly id?: number;
  readonly rasterize?: (code: string) => Promise<unknown>;
  readonly url?: string;
}) => {
  const sourcePng = makeSourcePng();
  const listeners = new Map<string, (...args: never[]) => void>();
  let currentUrl = options?.url ?? "http://localhost:3200/";
  let destroyed = false;
  let loading = false;
  const fetchImpl =
    options?.fetch ??
    (async () =>
      new Response(new Uint8Array(sourcePng), {
        headers: { "content-type": "image/png" },
      }));
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const response = fetchImpl(url, init);
    options?.changes?.notify();
    return response;
  });
  const executeJavaScriptInIsolatedWorld = vi.fn(
    (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) => {
      const result = options?.rasterize
        ? options.rasterize(scripts[0]?.code ?? "")
        : Promise.resolve(TEST_FAVICON);
      options?.changes?.notify();
      return result;
    },
  );
  const reload = vi.fn();
  const loadURL = vi.fn(async (url: string) => {
    currentUrl = url;
  });
  const off = vi.fn();
  const debuggerOff = vi.fn();
  const webContents = {
    id: options?.id ?? 42,
    isDestroyed: () => destroyed,
    getType: () => "webview",
    getURL: () => currentUrl,
    getTitle: () => "Preview",
    isLoadingMainFrame: () => loading,
    isDevToolsOpened: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    isCurrentlyAudible: () => false,
    reload,
    reloadIgnoringCache: vi.fn(),
    loadURL,
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
    }),
    off,
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    session: { fetch },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    isFocused: vi.fn(() => true),
    focusedFrame: {} as object | null,
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    executeJavaScriptInIsolatedWorld,
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: debuggerOff,
    },
  };
  return {
    executeJavaScriptInIsolatedWorld,
    fetch,
    debuggerOff,
    listeners,
    loadURL,
    off,
    reload,
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
    setLoading: (value: boolean) => {
      loading = value;
    },
    setUrl: (url: string) => {
      currentUrl = url;
    },
    webContents: webContents as never,
  };
};

// Electron mocks and state subscribers call `notify`, so a wait re-checks its
// predicate exactly when the state it reads changes.
const makeChangeSignal = () => {
  const waiters = new Set<() => void>();
  return {
    notify: () => {
      for (const wake of waiters) wake();
    },
    until: (predicate: () => boolean) =>
      Effect.callback<void>((resume) => {
        if (predicate()) return resume(Effect.void);
        const wake = () => {
          if (!predicate()) return;
          waiters.delete(wake);
          resume(Effect.void);
        };
        waiters.add(wake);
        return Effect.sync(() => void waiters.delete(wake));
      }),
  };
};
type ChangeSignal = ReturnType<typeof makeChangeSignal>;

// Favicon captures run detached from the Electron listener, so asserting that
// one published nothing can only give its promise chain a fixed number of turns.
const flushMicrotasks = function* () {
  for (let turn = 0; turn < 30; turn++) yield* Effect.promise(() => Promise.resolve());
};

const makeTestPictureInPictureWindow = (loadURL: () => Promise<void> = async () => undefined) => {
  const listeners = new Map<string, () => void>();
  const webContentsListeners = new Map<string, () => void>();
  const send = vi.fn();
  let destroyed = false;
  const webContents = {
    on: vi.fn((event: string, listener: () => void) => {
      webContentsListeners.set(event, listener);
    }),
    off: vi.fn((event: string) => {
      webContentsListeners.delete(event);
    }),
    send,
  };
  const pictureInPictureWindow = {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAspectRatio: vi.fn(),
    getContentSize: vi.fn(() => [480, 320]),
    setContentSize: vi.fn(),
    loadURL: vi.fn(loadURL),
    showInactive: vi.fn(() => {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
    }),
    close: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      listeners.get("closed")?.();
    }),
    get webContents() {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
      return webContents;
    },
  };
  return { pictureInPictureWindow, send, webContentsListeners };
};

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    previewSession.on.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    clipboardItemConstructor.mockClear();
    writeClipboard.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });

  effectIt.effect(
    "creates one main-owned host for concurrent requests and preserves its page",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          const hosted: Electron.WebContents[] = [];
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.subscribeHostedContents((owner, contents) =>
            Effect.sync(() => {
              expect(owner).toBe(fixture.owner);
              hosted.push(contents);
            }),
          );
          yield* manager.createTab("osr_tab", { zoomFactor: 1.25 });
          const states = yield* Effect.all(
            [
              manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7),
              manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7),
            ],
            { concurrency: 2 },
          );
          expect(states).toEqual([
            { kind: "offscreen", webContentsId: 42, privateEntry: false },
            { kind: "offscreen", webContentsId: 42, privateEntry: false },
          ]);
          expect(browserWindowConstructor).toHaveBeenCalledOnce();
          expect(fixture.window.setContentSize).toHaveBeenCalledExactlyOnceWith(1800, 2125);
          expect(hosted).toEqual([fixture.wc]);
          expect(fixture.wc.loadURL).not.toHaveBeenCalled();
          const mismatch = yield* Effect.exit(
            manager.ensureOffscreenHost(
              "osr_tab",
              {
                ...fixture.configuration,
                partition: "persist:t3code-preview-other",
              },
              7,
            ),
          );
          expect(Exit.isFailure(mismatch)).toBe(true);
          expect(browserWindowConstructor).toHaveBeenCalledOnce();
          expect(fixture.window.destroy).not.toHaveBeenCalled();
        }),
      ),
  );

  effectIt.effect(
    "returns a healthy legacy webview without creating or navigating another guest",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          const legacy = Object.assign(makeTestPreviewWebContents(fixture.capturePage, 43), {
            hostWebContents: fixture.owner.webContents,
          });
          fromId.mockReturnValue(legacy);
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("legacy_tab");
          yield* manager.registerWebview("legacy_tab", legacy.id);
          const state = yield* manager.ensureOffscreenHost("legacy_tab", fixture.configuration, 7);
          expect(state).toEqual({ kind: "webview", webContentsId: 43, privateEntry: false });
          expect(browserWindowConstructor).not.toHaveBeenCalled();
          expect(fixture.wc.loadURL).not.toHaveBeenCalled();
          expect(yield* manager.restoreSurfaceFocus(legacy)).toBe(false);
        }),
      ),
  );

  effectIt.effect.each(["ready document", "no document"] as const)(
    "navigates a newly created Idle tab from initialUrl once through pending navigation: %s",
    (renderer) =>
      withManager((manager, host) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          const serverTab = { threadId: "unit-thread", tabId: "unit-tab" };
          using attach = vi.spyOn(host, "attach");
          let currentUrl = renderer === "ready document" ? fixture.wc.getURL() : "";
          fixture.wc.getURL = () => currentUrl;
          fixture.wc.debugger.sendCommand.mockImplementation(async () => {
            if (currentUrl === "") throw new Error("The renderer has no document yet.");
            return undefined;
          });
          const loaded = Promise.withResolvers<void>();
          fixture.wc.loadURL.mockImplementation(async (url) => {
            currentUrl = url;
            if (url === "https://example.com/initial") loaded.resolve();
          });
          yield* manager.setMainWindow(fixture.owner);
          const tab = yield* manager.createTab("osr_tab", {
            initialUrl: "https://example.com/initial",
            serverTab,
          });
          expect(tab.navStatus).toMatchObject({
            kind: "Loading",
            url: "https://example.com/initial",
          });
          expect(fixture.wc.loadURL).not.toHaveBeenCalled();
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          expect(attach).toHaveBeenCalledWith(
            serverTab,
            expect.objectContaining({
              webContents: fixture.wc,
              debugger: fixture.wc.debugger,
            }),
          );
          expect(fixture.wc.debugger.isAttached()).toBe(true);
          yield* Effect.promise(() => loaded.promise);
          yield* manager.createTab("osr_tab", { initialUrl: "https://example.com/stale-snapshot" });
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          expect(fixture.wc.loadURL.mock.calls.map(([url]) => url)).toEqual(
            renderer === "ready document"
              ? ["https://example.com/initial"]
              : ["about:blank", "https://example.com/initial"],
          );
          expect(fixture.wc.getURL()).toBe("https://example.com/initial");
          expect(browserWindowConstructor).toHaveBeenCalledOnce();
        }),
      ),
  );

  effectIt.effect(
    "retires a crashed OSR host and restores its pending URL into one fresh host",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("osr_tab", { initialUrl: "https://example.com/restore" });
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          const retired = Promise.withResolvers<void>();
          fixture.events.once("destroyed", () => retired.resolve());
          fixture.events.emit("render-process-gone");
          yield* Effect.promise(() => retired.promise);
          expect(fixture.window.destroy).toHaveBeenCalledOnce();
          const recovery = makeOffscreenFixture(fixture.owner);
          const loaded = Promise.withResolvers<void>();
          recovery.wc.loadURL.mockImplementation(async () => {
            loaded.resolve();
          });
          yield* manager.ensureOffscreenHost("osr_tab", recovery.configuration, 7);
          yield* Effect.promise(() => loaded.promise);
          expect(recovery.wc.loadURL).toHaveBeenCalledExactlyOnceWith(
            "https://example.com/restore",
          );
          yield* manager.ensureOffscreenHost("osr_tab", recovery.configuration, 7);
          expect(recovery.wc.loadURL).toHaveBeenCalledOnce();
          expect(recovery.window.destroy).not.toHaveBeenCalled();
        }),
      ),
  );

  effectIt.effect(
    "encodes one local frame until the matching ACK and repaints only dropped changes",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("osr_tab");
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          const presentation = { tabId: "osr_tab", surfaceId: "surface_a", visible: true };
          yield* manager.presentSurface(presentation, 7);
          const first = fixture.paint("a");
          const identity = fixture.send.mock.calls[0]![1];
          yield* manager.ackSurface({ ...identity, generation: identity.generation + 1 }, 7);
          const dropped = fixture.paint("b");
          expect(first.toPNG).toHaveBeenCalledOnce();
          expect(dropped.toPNG).not.toHaveBeenCalled();
          expect(fixture.send).toHaveBeenCalledOnce();
          const beforeDirtyAck = fixture.wc.invalidate.mock.calls.length;
          yield* manager.ackSurface(identity, 7);
          expect(fixture.wc.invalidate).toHaveBeenCalledTimes(beforeDirtyAck + 1);
          fixture.paint("b");
          const next = fixture.send.mock.calls[1]![1];
          fixture.paint("b");
          const beforeCleanAck = fixture.wc.invalidate.mock.calls.length;
          yield* manager.ackSurface(next, 7);
          expect(fixture.wc.invalidate).toHaveBeenCalledTimes(beforeCleanAck);
          fixture.paint("b");
          expect(fixture.send).toHaveBeenCalledTimes(2);
          yield* manager.presentSurface(
            { ...presentation, surfaceId: "surface_b", visible: false },
            7,
          );
          fixture.paint("c");
          expect(fixture.send).toHaveBeenCalledTimes(3);
          yield* manager.presentSurface({ ...presentation, visible: false }, 7);
          const hidden = fixture.paint("d");
          expect(hidden.toBitmap).not.toHaveBeenCalled();
          expect(hidden.toPNG).not.toHaveBeenCalled();
          expect(fixture.send).toHaveBeenCalledTimes(3);
        }),
      ),
  );

  effectIt.effect(
    "uses confirmed main-renderer focus for OSR private entry and explicit resume",
    () =>
      withAutofillManager((manager, authorityReady, peer) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("osr_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          yield* Deferred.await(authorityReady);
          yield* manager.presentSurface(
            { tabId: "osr_tab", surfaceId: "surface_a", visible: true },
            7,
          );
          fixture.paint();
          const identity = fixture.send.mock.calls.at(-1)![1];
          yield* manager.ackSurface(identity, 7);
          const target = yield* manager.getAutofillTarget(fixture.wc, fixture.wc.mainFrame);
          expect(target).toBeDefined();
          expect(target?.current()).toBe(false);
          const requested = Promise.withResolvers<DesktopPreviewSurfaceFocusRequest>();
          fixture.focusRequest.mockImplementation((request) => requested.resolve(request));
          const restore = yield* manager
            .restoreSurfaceFocus(fixture.wc, "begin-private-entry")
            .pipe(Effect.forkScoped);
          const preparation = yield* Effect.promise(() => requested.promise);
          expect(preparation.preparation).toBe("begin");
          const focusRequested = Promise.withResolvers<DesktopPreviewSurfaceFocusRequest>();
          fixture.focusRequest.mockImplementation((request) => focusRequested.resolve(request));
          yield* manager.focusSurface(
            { ...preparation, requestId: "stale-preparation", prepared: true, focused: false },
            7,
          );
          expect(fixture.focusRequest).toHaveBeenCalledTimes(1);
          yield* manager.focusSurface({ ...preparation, prepared: true, focused: false }, 7);
          expect(target?.current()).toBe(false);
          const request = yield* Effect.promise(() => focusRequested.promise);
          expect(request.preparation).toBeUndefined();
          yield* manager.focusSurface({ ...request, requestId: "stale-request", focused: true }, 7);
          expect(target?.current()).toBe(false);
          yield* manager.focusSurface({ ...request, focused: true }, 7);
          expect(yield* Fiber.join(restore)).toBe(true);
          expect(fixture.wc.isFocused()).toBe(false);
          expect(target?.current()).toBe(true);
          fixture.paint("unchanged");
          const decoding = fixture.send.mock.calls.at(-1)![1];
          expect(decoding.sequence).toBeGreaterThan(identity.sequence);
          expect(target?.current()).toBe(true);
          yield* manager.ackSurface(decoding, 7);
          expect(target?.current()).toBe(false);
          yield* manager.focusSurface({ ...decoding, focused: true }, 7);
          expect(target?.current()).toBe(true);
          const privacyInvalidated = Promise.withResolvers<void>();
          fixture.wc.invalidate.mockImplementationOnce(() => privacyInvalidated.resolve());
          yield* Effect.promise(() => target!.enterPrivate());
          yield* manager.restoreSurfaceFocus(fixture.wc, "finish-private-entry");
          expect(fixture.focusRequest.mock.calls.at(-1)![0]).toMatchObject({
            preparation: "finish",
            privateEntry: true,
          });
          expect(peer.host.isPrivateEntry(fixture.wc)).toBe(true);
          yield* Effect.promise(() => privacyInvalidated.promise);
          fixture.paint("unchanged");
          const privateFrame = fixture.send.mock.calls.at(-1)![1];
          expect(privateFrame.privateEntry).toBe(true);
          expect(target?.current()).toBe(true);
          yield* manager.ackSurface(privateFrame, 7);
          expect(target?.current()).toBe(false);
          yield* manager.focusSurface({ ...privateFrame, focused: true }, 7);
          expect(target?.current()).toBe(true);
          fixture.wc.executeJavaScript.mockResolvedValueOnce(true);
          yield* manager.sendSurfaceInput(
            { ...privateFrame, input: { type: "text", text: "unit-private-input" } },
            7,
          );
          expect(fixture.wc.insertText).toHaveBeenCalledExactlyOnceWith("unit-private-input");
          const resumeRequested = Promise.withResolvers<DesktopPreviewSurfaceFocusRequest>();
          fixture.focusRequest.mockImplementation((next) => resumeRequested.resolve(next));
          const restoreForResume = yield* manager
            .restoreSurfaceFocus(fixture.wc)
            .pipe(Effect.forkScoped);
          const resumeRequest = yield* Effect.promise(() => resumeRequested.promise);
          expect(resumeRequest.preparation).toBeUndefined();
          expect(resumeRequest.requestId).not.toBe(request.requestId);
          yield* manager.focusSurface({ ...resumeRequest, focused: true }, 7);
          expect(yield* Fiber.join(restoreForResume)).toBe(true);
          const sharingInvalidated = Promise.withResolvers<void>();
          fixture.wc.invalidate.mockImplementationOnce(() => sharingInvalidated.resolve());
          fixture.wc.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async () => {
            fixture.paint("cleared-fields");
            const cleared = { ...fixture.send.mock.calls.at(-1)![1], focused: true };
            await Effect.runPromise(manager.ackSurface(cleared, 7));
            expect(target?.current()).toBe(true);
            return true;
          });
          yield* Effect.promise(() => target!.clearAndResume());
          expect(peer.host.isPrivateEntry(fixture.wc)).toBe(false);
          yield* Effect.promise(() => sharingInvalidated.promise);
          fixture.paint("unchanged");
          expect(fixture.send.mock.calls.at(-1)![1].privateEntry).toBe(false);
          expect(fixture.wc.debugger.sendCommand).not.toHaveBeenCalledWith(
            "Input.insertText",
            expect.anything(),
          );
        }),
      ),
  );

  for (const boundary of [
    "no-confirmation",
    "frame-ack-only",
    "foreign-sender",
    "wrong-surface",
    "wrong-webcontents",
    "stale-frame",
    "stale-generation",
    "false-proof",
    "owner-blur",
    "hidden",
    "document-epoch",
    "close",
  ] as const) {
    effectIt.effect(`refuses OSR autofill focus at the ${boundary} boundary`, () =>
      withAutofillManager((manager, authorityReady) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          fixture.wc.isFocused.mockReturnValue(true);
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("osr_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          yield* Deferred.await(authorityReady);
          const presentation = { tabId: "osr_tab", surfaceId: "surface_a", visible: true };
          yield* manager.presentSurface(presentation, 7);
          fixture.paint();
          const identity = fixture.send.mock.calls.at(-1)![1];
          if (boundary !== "no-confirmation") yield* manager.ackSurface(identity, 7);
          const target = yield* manager.getAutofillTarget(fixture.wc, fixture.wc.mainFrame);
          expect(target).toBeDefined();
          const proof = { ...identity, focused: true };
          if (boundary === "foreign-sender") {
            expect(Exit.isFailure(yield* Effect.exit(manager.focusSurface(proof, 8)))).toBe(true);
          } else if (boundary === "wrong-surface") {
            yield* manager.focusSurface({ ...proof, surfaceId: "other-surface" }, 7);
          } else if (boundary === "wrong-webcontents") {
            yield* manager.focusSurface({ ...proof, webContentsId: 43 }, 7);
          } else if (boundary === "stale-frame") {
            yield* manager.ackSurface(identity, 7);
            fixture.paint("new-frame");
            yield* manager.ackSurface(fixture.send.mock.calls.at(-1)![1], 7);
            yield* manager.focusSurface(proof, 7);
          } else if (boundary === "stale-generation") {
            yield* manager.ensureOffscreenHost(
              "osr_tab",
              {
                ...fixture.configuration,
                viewport: { _tag: "freeform", width: 900, height: 650 },
              },
              7,
            );
            yield* manager.focusSurface(proof, 7);
          } else if (boundary !== "no-confirmation" && boundary !== "frame-ack-only") {
            yield* manager.focusSurface(proof, 7);
            expect(target?.current()).toBe(true);
            if (boundary === "false-proof") {
              yield* manager.focusSurface({ ...proof, focused: false }, 7);
            } else if (boundary === "owner-blur") {
              fixture.ownerFocused.mockReturnValue(false);
              expect(target?.current()).toBe(false);
              fixture.ownerEvents.emit("blur");
              fixture.ownerFocused.mockReturnValue(true);
            } else if (boundary === "hidden") {
              yield* manager.presentSurface({ ...presentation, visible: false }, 7);
              yield* manager.presentSurface(presentation, 7);
              fixture.paint("shown-again");
              yield* manager.focusSurface(proof, 7);
            } else if (boundary === "document-epoch") {
              fixture.events.emit("did-start-navigation", { isMainFrame: true });
              yield* manager.ackSurface(identity, 7);
              fixture.paint("new-document");
              yield* manager.ackSurface(fixture.send.mock.calls.at(-1)![1], 7);
              yield* manager.focusSurface(
                { ...fixture.send.mock.calls.at(-1)![1], focused: true },
                7,
              );
            } else if (boundary === "close") {
              yield* manager.closeTab("osr_tab");
              expect(
                Exit.isFailure(yield* Effect.exit(manager.restoreSurfaceFocus(fixture.wc))),
              ).toBe(true);
            }
          }
          expect(target?.current()).toBe(false);
          expect(
            Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => target!.enterPrivate()))),
          ).toBe(true);
          expect(fixture.wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
          expect(fixture.wc.insertText).not.toHaveBeenCalled();
        }),
      ),
    );
  }

  for (const boundary of ["timeout", "blur", "hide", "navigate", "close"] as const) {
    effectIt.effect(`cancels a pending OSR menu focus request on ${boundary}`, () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("osr_tab");
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          const presentation = { tabId: "osr_tab", surfaceId: "surface_a", visible: true };
          yield* manager.presentSurface(presentation, 7);
          fixture.paint();
          yield* manager.ackSurface(fixture.send.mock.calls.at(-1)![1], 7);
          const requested = Promise.withResolvers<DesktopPreviewSurfaceFocusRequest>();
          fixture.focusRequest.mockImplementation((request) => requested.resolve(request));
          const restore = yield* manager.restoreSurfaceFocus(fixture.wc).pipe(Effect.forkScoped);
          const request = yield* Effect.promise(() => requested.promise);
          expect(Exit.isFailure(yield* Effect.exit(manager.restoreSurfaceFocus(fixture.wc)))).toBe(
            true,
          );
          if (boundary === "timeout") yield* TestClock.adjust(1_000);
          else if (boundary === "blur") fixture.ownerEvents.emit("blur");
          else if (boundary === "hide") {
            yield* manager.presentSurface({ ...presentation, visible: false }, 7);
          } else if (boundary === "navigate") {
            fixture.events.emit("did-start-navigation", { isMainFrame: true });
          } else yield* manager.closeTab("osr_tab");
          expect(Exit.isFailure(yield* Fiber.await(restore))).toBe(true);
          yield* manager.focusSurface({ ...request, focused: true }, 7);
          expect(fixture.wc.insertText).not.toHaveBeenCalled();
        }),
      ),
    );
  }

  effectIt.effect("rechecks real main-window focus after awaited OSR private work", () =>
    withAutofillManager((manager, authorityReady) =>
      Effect.gen(function* () {
        const fixture = makeOffscreenFixture();
        yield* manager.setMainWindow(fixture.owner);
        yield* manager.createTab("osr_tab", {
          serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
        });
        yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
        yield* Deferred.await(authorityReady);
        yield* manager.presentSurface(
          { tabId: "osr_tab", surfaceId: "surface_a", visible: true },
          7,
        );
        fixture.paint();
        yield* manager.ackSurface(fixture.send.mock.calls.at(-1)![1], 7);
        yield* manager.focusSurface({ ...fixture.send.mock.calls.at(-1)![1], focused: true }, 7);
        const target = yield* manager.getAutofillTarget(fixture.wc, fixture.wc.mainFrame);
        yield* Effect.promise(() => target!.enterPrivate());
        fixture.paint("private-frame");
        yield* manager.ackSurface(fixture.send.mock.calls.at(-1)![1], 7);
        yield* manager.focusSurface({ ...fixture.send.mock.calls.at(-1)![1], focused: true }, 7);
        const entered = Promise.withResolvers<void>();
        const settled = Promise.withResolvers<boolean>();
        fixture.wc.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => {
          entered.resolve();
          return settled.promise;
        });
        const assertion = yield* Effect.tryPromise(async () => {
          await target!.assertPrivate();
        }).pipe(Effect.forkScoped);
        yield* Effect.promise(() => entered.promise);
        fixture.ownerFocused.mockReturnValue(false);
        settled.resolve(true);
        expect(Exit.isFailure(yield* Fiber.await(assertion))).toBe(true);
        expect(target?.current()).toBe(false);
      }),
    ),
  );

  effectIt.effect(
    "rejects foreign senders and private input without the existing live reservation",
    () =>
      withManager((manager, authority) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("osr_tab");
          expect(
            Exit.isFailure(
              yield* Effect.exit(manager.ensureOffscreenHost("osr_tab", fixture.configuration, 8)),
            ),
          ).toBe(true);
          expect(browserWindowConstructor).not.toHaveBeenCalled();
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          const presentation = { tabId: "osr_tab", surfaceId: "surface_a", visible: true };
          yield* manager.presentSurface(presentation, 7);
          fixture.paint();
          const identity = fixture.send.mock.calls[0]![1];
          const input = {
            ...identity,
            input: { type: "text" as const, text: "unit-private-text" },
          };
          for (const operation of [
            manager.presentSurface(presentation, 8).pipe(Effect.asVoid),
            manager.ackSurface(identity, 8),
            manager.sendSurfaceInput(input, 8).pipe(Effect.asVoid),
            manager.sendSurfaceInput(input, 7).pipe(Effect.asVoid),
          ]) {
            expect(Exit.isFailure(yield* Effect.exit(operation))).toBe(true);
          }
          authority.setPrivateEntry(fixture.wc, true);
          yield* manager.ackSurface(identity, 7);
          fixture.paint("private-frame");
          const privateFrame = fixture.send.mock.calls.at(-1)![1];
          expect(privateFrame.privateEntry).toBe(true);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                manager.sendSurfaceInput(
                  {
                    ...privateFrame,
                    input: input.input,
                  },
                  7,
                ),
              ),
            ),
          ).toBe(true);
          expect(fixture.wc.insertText).not.toHaveBeenCalled();
          expect(fixture.wc.sendInputEvent).not.toHaveBeenCalled();
          expect(fixture.wc.debugger.sendCommand).not.toHaveBeenCalledWith(
            "Input.insertText",
            expect.anything(),
          );
          authority.setPrivateEntry(fixture.wc, false);
        }),
      ),
  );

  for (const boundary of ["navigation", "resize-return"] as const) {
    effectIt.effect(`rejects an OSR screenshot crossing ${boundary}`, () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          const pending = Promise.withResolvers<ReturnType<typeof fixture.image>>();
          const started = Promise.withResolvers<void>();
          fixture.capturePage.mockImplementation(() => {
            started.resolve();
            return pending.promise;
          });
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("osr_tab");
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          const capture = yield* manager
            .captureScreenshot("osr_tab")
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Effect.promise(() => started.promise);
          if (boundary === "navigation") {
            fixture.events.emit("did-start-navigation", {
              isMainFrame: true,
              isSameDocument: false,
            });
          } else {
            yield* manager.ensureOffscreenHost(
              "osr_tab",
              {
                ...fixture.configuration,
                viewport: { _tag: "freeform", width: 900, height: 650 },
              },
              7,
            );
            yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          }
          pending.resolve(fixture.image());
          const result = yield* Fiber.join(capture);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
              _tag: "PreviewCaptureRaceError",
              tabId: "osr_tab",
              webContentsId: 42,
            });
          }
          expect(writeFile).not.toHaveBeenCalled();
        }),
      ),
    );
  }

  effectIt.effect(
    "keeps a timed-out native capture held until its original promise settles after close",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const fixture = makeOffscreenFixture();
          const pending = Promise.withResolvers<ReturnType<typeof fixture.image>>();
          const started = Promise.withResolvers<void>();
          fixture.capturePage.mockImplementation(() => {
            started.resolve();
            return pending.promise;
          });
          yield* manager.setMainWindow(fixture.owner);
          yield* manager.createTab("osr_tab");
          yield* manager.ensureOffscreenHost("osr_tab", fixture.configuration, 7);
          const capture = yield* manager
            .captureScreenshot("osr_tab")
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Effect.promise(() => started.promise);
          yield* TestClock.adjust(1_000);
          expect(Exit.isFailure(yield* Fiber.join(capture))).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(manager.captureScreenshot("osr_tab")))).toBe(
            true,
          );
          expect(fixture.capturePage).toHaveBeenCalledOnce();
          yield* manager.closeTab("osr_tab");
          expect(fixture.window.destroy).not.toHaveBeenCalled();
          const destroyed = Promise.withResolvers<void>();
          fixture.events.once("destroyed", () => destroyed.resolve());
          pending.resolve(fixture.image());
          yield* Effect.promise(() => destroyed.promise);
          expect(fixture.window.destroy).toHaveBeenCalledOnce();
          expect(writeFile).not.toHaveBeenCalled();
        }),
      ),
  );

  it("drains native and CDP capture holds after disposal and releases each hold once", async () => {
    const fixture = makeOffscreenFixture();
    const pending = Promise.withResolvers<ReturnType<typeof fixture.image>>();
    fixture.capturePage.mockImplementation(() => pending.promise);
    const host = createOffscreenHost({
      ...fixture.configuration,
      tabId: "osr_tab",
      zoomFactor: 1,
      deviceScaleFactor: 1,
      additionalArguments: [],
      owner: fixture.owner,
      isCurrent: () => true,
      isPrivateEntry: () => false,
      onGone: () => {},
    });
    const releaseCdp = host.acquireCaptureHold();
    const native = host.capturePage();
    host.dispose();
    expect(() => host.acquireCaptureHold()).toThrow();
    expect(fixture.window.destroy).not.toHaveBeenCalled();
    releaseCdp();
    releaseCdp();
    expect(fixture.window.destroy).not.toHaveBeenCalled();
    pending.resolve(fixture.image());
    await native;
    expect(fixture.window.destroy).toHaveBeenCalledOnce();
  });

  effectIt.effect("opens a target=_blank link as a new tab without navigating the opener", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const opened: Array<{ tabId: string; url: string; background: boolean }> = [];
        const openedReady = yield* Deferred.make<void>();
        yield* manager.subscribeOpenLinks((event) =>
          Effect.sync(() => void opened.push(event)).pipe(
            Effect.andThen(() =>
              opened.length === 2 ? Deferred.succeed(openedReady, undefined) : Effect.void,
            ),
          ),
        );
        yield* manager.createTab("tab_links");
        yield* manager.registerWebview("tab_links", 42);
        const openHandler = (preview.webContents as Electron.WebContents).setWindowOpenHandler as
          | ReturnType<typeof vi.fn>
          | undefined;
        const handler = openHandler?.mock.lastCall?.[0] as (
          details: Partial<Electron.HandlerDetails>,
        ) => { action: string };

        expect(
          handler({ url: "https://github.com/issues/1", disposition: "foreground-tab" }),
        ).toEqual({ action: "deny" });
        expect(handler({ url: "about:blank", disposition: "new-window" })).toEqual({
          action: "deny",
        });
        handler({ url: "https://github.com/issues/2", disposition: "background-tab" });
        yield* Deferred.await(openedReady);

        expect(preview.loadURL).not.toHaveBeenCalled();
        expect(opened).toEqual([
          { tabId: "tab_links", url: "https://github.com/issues/1", background: false },
          { tabId: "tab_links", url: "https://github.com/issues/2", background: true },
        ]);
      }),
    ),
  );

  effectIt.effect("keeps preview shortcuts out of the host window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        const sendInputEvent = vi.fn();
        const hostWebContents = { sendInputEvent, isDestroyed: () => false };
        Object.assign(preview.webContents, { hostWebContents });
        fromId.mockReturnValue(preview.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_keys");
        yield* manager.registerWebview("tab_keys", 42);

        expect(
          (preview.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenCalledWith(true);
        const beforeInput = preview.listeners.get("before-input-event")!;
        for (const control of [false, true]) {
          for (const key of ["k", ",", "w", "j", "q", "+"]) {
            for (const type of ["keyDown", "keyUp"]) {
              const preventDefault = vi.fn();
              beforeInput(
                { preventDefault } as never,
                { type, key, meta: !control, control, shift: key === "j", alt: false } as never,
              );
              yield* Effect.yieldNow;
              expect(preventDefault).not.toHaveBeenCalled();
              expect(
                (preview.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
              ).toHaveBeenLastCalledWith(true);
            }
          }
        }
        expect(sendInputEvent).not.toHaveBeenCalled();

        const preventDefault = vi.fn();
        beforeInput(
          { preventDefault } as never,
          {
            type: "keyDown",
            key: "r",
            meta: true,
            control: false,
            shift: false,
            alt: false,
          } as never,
        );
        yield* Effect.yieldNow;
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(preview.reload).toHaveBeenCalledOnce();
        expect(sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect.each([
    ["ctrl+shift+space", "navigation.activate"],
    ["mod+shift+t", "view.reopenClosed"],
    ["ctrl+alt+u", "sidebar.toggle"],
  ] as const)(
    "forwards only the configured command from the focused guest: %s",
    ([chord, command]) =>
      withManager((manager) =>
        Effect.gen(function* () {
          const preview = makeFaviconWebContents();
          const send = vi.fn();
          Object.assign(preview.webContents, {
            hostWebContents: { isDestroyed: () => false, send },
          });
          fromId.mockReturnValue(preview.webContents);
          yield* manager.createTab("tab_reopen");
          yield* manager.registerWebview("tab_reopen", 42);
          const shortcut = parseKeybindingShortcut(chord)!;
          yield* manager.setForwardedShortcuts([{ command, shortcut }]);
          const beforeInput = preview.listeners.get("before-input-event")!;
          const input = {
            type: "keyDown",
            key: shortcut.key.toUpperCase(),
            meta: shortcut.metaKey || shortcut.modKey,
            control: shortcut.ctrlKey,
            shift: shortcut.shiftKey,
            alt: shortcut.altKey,
          };
          const preventDefault = vi.fn();
          beforeInput({ preventDefault } as never, input as never);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(send).toHaveBeenCalledExactlyOnceWith("desktop:menu-action", command);
          for (const overrides of [
            { isAutoRepeat: true },
            { type: "keyUp" },
            { shift: !input.shift },
            { key: "x" },
          ]) {
            preventDefault.mockClear();
            beforeInput({ preventDefault } as never, { ...input, ...overrides } as never);
            expect(preventDefault).toHaveBeenCalledTimes("isAutoRepeat" in overrides ? 1 : 0);
            expect(send).toHaveBeenCalledOnce();
          }
          vi.mocked((preview.webContents as Electron.WebContents).isFocused).mockReturnValue(false);
          preventDefault.mockClear();
          beforeInput({ preventDefault } as never, input as never);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(send).toHaveBeenCalledOnce();
          vi.mocked((preview.webContents as Electron.WebContents).isFocused).mockReturnValue(true);
          yield* manager.setForwardedShortcuts([]);
          beforeInput({ preventDefault } as never, input as never);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(send).toHaveBeenCalledOnce();
        }),
      ),
  );

  effectIt.effect.each([
    ["linux", "ctrl+alt+[", "[", "BracketLeft", false],
    ["win32", "ctrl+alt+8", "[", "Digit8", false],
    ["win32", "ctrl+alt+k", "K", "KeyK", false],
    ["linux", "ctrl+alt+`", "Dead", "Backquote", false],
    ["darwin", "ctrl+alt+[", "[", "BracketLeft", true],
    ["linux", "ctrl+alt+f7", "F7", "F7", true],
  ] as const)(
    "handles ambiguous preview chords on %s: %s",
    ([platform, chord, key, code, expected]) =>
      withManager(
        (manager) =>
          Effect.gen(function* () {
            const preview = makeFaviconWebContents();
            const send = vi.fn();
            Object.assign(preview.webContents, {
              hostWebContents: { isDestroyed: () => false, send },
            });
            fromId.mockReturnValue(preview.webContents);
            yield* manager.createTab("tab_alt_graph");
            yield* manager.registerWebview("tab_alt_graph", 42);
            yield* manager.setForwardedShortcuts([
              { command: "view.reopenClosed", shortcut: parseKeybindingShortcut(chord)! },
            ]);
            const preventDefault = vi.fn();
            preview.listeners.get("before-input-event")!(
              { preventDefault } as never,
              {
                type: "keyDown",
                key,
                code,
                meta: false,
                control: true,
                shift: false,
                alt: true,
              } as never,
            );
            expect(preventDefault).toHaveBeenCalledTimes(expected ? 1 : 0);
            expect(send).toHaveBeenCalledTimes(expected ? 1 : 0);
          }),
        platform,
      ),
  );

  effectIt.effect("keeps editing and forwarded shortcuts in whichever tab holds focus", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const send = vi.fn();
        const focus = vi.fn();
        const host = { isDestroyed: () => false, send, focus };
        const older = makeFaviconWebContents({ id: 42 });
        const newer = makeFaviconWebContents({ id: 43 });
        for (const tab of [older, newer]) Object.assign(tab.webContents, { hostWebContents: host });
        getFocusedWebContents.mockReturnValue(newer.webContents as never);
        fromId.mockReturnValue(older.webContents);
        yield* manager.createTab("tab_older");
        yield* manager.registerWebview("tab_older", 42);
        fromId.mockReturnValue(newer.webContents);
        yield* manager.createTab("tab_newer");
        yield* manager.registerWebview("tab_newer", 43);
        const shortcut = parseKeybindingShortcut("mod+shift+t")!;
        yield* manager.setForwardedShortcuts([{ command: "view.reopenClosed", shortcut }]);

        const beforeInput = older.listeners.get("before-input-event")!;
        const key = { type: "keyDown", meta: true, control: false, alt: false };
        beforeInput(
          { preventDefault: vi.fn() } as never,
          { ...key, key: "v", shift: false } as never,
        );
        expect(
          (older.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(false);

        const preventDefault = vi.fn();
        beforeInput({ preventDefault } as never, { ...key, key: "T", shift: true } as never);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledExactlyOnceWith("desktop:menu-action", "view.reopenClosed");

        yield* manager.setForwardedShortcuts([
          { command: "preview.focusUrl", shortcut: parseKeybindingShortcut("mod+l")! },
        ]);
        beforeInput({ preventDefault } as never, { ...key, key: "l", shift: false } as never);
        expect(focus).toHaveBeenCalledOnce();
        expect(send).toHaveBeenLastCalledWith("desktop:menu-action", "preview.focusUrl");
        expect(focus.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]!);
        beforeInput(
          { preventDefault } as never,
          { ...key, key: "l", shift: false, isAutoRepeat: true } as never,
        );
        expect(focus).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledTimes(2);
        send.mockClear();
        yield* manager.setForwardedShortcuts([{ command: "view.reopenClosed", shortcut }]);

        Object.assign(newer.webContents, { focusedFrame: null });
        const agentInput = newer.listeners.get("before-input-event")!;
        const agentPreventDefault = vi.fn();
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "v", shift: false } as never,
        );
        expect(
          (newer.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(true);
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "T", shift: true } as never,
        );
        expect(agentPreventDefault).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("isolates failed state listeners and continues delivery", () => {
    const loggedErrors: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      for (const value of Array.isArray(message) ? message : [message]) {
        if (typeof value === "object" && value !== null && "cause" in value) {
          loggedErrors.push(Cause.squash(value.cause as Cause.Cause<never>));
        }
      }
    });
    const deliveryError = new ElectronWindow.ElectronWindowOperationError({
      operation: "send-window-message",
      platform: "darwin",
      windowId: 42,
      channel: "preview:state-change",
      cause: new Error("renderer unavailable"),
    });
    const delivered = vi.fn();

    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.subscribeStateChanges(() => Effect.die(deliveryError));
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            delivered(tabId, state);
          }),
        );

        const state = yield* manager.createTab("tab_listener_failure");

        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered).toHaveBeenCalledWith("tab_listener_failure", state);
        expect(loggedErrors).toHaveLength(1);
        expect(loggedErrors[0]).toBeInstanceOf(ElectronWindow.ElectronWindowOperationError);
        expect(loggedErrors[0]).toMatchObject({
          operation: "send-window-message",
          windowId: 42,
          channel: "preview:state-change",
        });
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([logger], {
          mergeWithExisting: false,
        }),
      ),
    );
  });

  effectIt.effect("does not swallow state listener interruption", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* manager.subscribeStateChanges(() => Effect.interrupt);
            return yield* Effect.exit(manager.createTab("tab_interrupted_listener"));
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
    ),
  );

  effectIt.effect("queues navigation until the webview registers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => undefined);
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "about:blank",
          getTitle: () => "",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.navigate("tab_pending", "localhost:3200");

        yield* manager.registerWebview("tab_pending", 42);
        yield* Effect.yieldNow;

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith("http://localhost:3200/");
      }),
    ),
  );

  effectIt.effect("detaches through the pinned debugger after the webview is destroyed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let destroyed = false;
        let attached = false;
        const debuggerOff = vi.fn();
        const debuggerDetach = vi.fn(() => {
          attached = false;
        });
        const wcDebugger = {
          isAttached: () => attached,
          attach: vi.fn(() => {
            attached = true;
          }),
          detach: debuggerDetach,
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: debuggerOff,
        };
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => destroyed,
          getType: () => "webview",
          getURL: () => "http://localhost:3200/",
          getTitle: () => "Preview",
          isLoadingMainFrame: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          reload: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          get debugger() {
            if (destroyed) throw new Error("Object has been destroyed");
            return wcDebugger;
          },
        } as never);
        yield* manager.createTab("tab_pinned_debugger");
        yield* manager.registerWebview("tab_pinned_debugger", 42);
        yield* manager.setColorScheme("tab_pinned_debugger", "dark");
        expect(attached).toBe(true);
        destroyed = true;

        yield* manager.navigate("tab_pinned_debugger", "https://example.com/");

        expect(debuggerOff).toHaveBeenCalledWith("message", expect.any(Function));
        expect(debuggerDetach).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("does not let destroyed-webview cleanup detach a same-id replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const previous = makeFaviconWebContents();
        const replacement = makeFaviconWebContents({ url: "https://example.com/" });
        let current = previous.webContents;
        let startReplacementRegistration: () => void = () => void 0;
        const replacementReady = new Promise<void>((resolve) => {
          startReplacementRegistration = resolve;
        });
        fromId.mockImplementation(() => current);
        yield* manager.createTab("tab_destroyed_replacement_race");
        yield* manager.registerWebview("tab_destroyed_replacement_race", 42);
        yield* manager.setColorScheme("tab_destroyed_replacement_race", "dark");
        const replacementRegistration = yield* Effect.promise(() => replacementReady).pipe(
          Effect.flatMap(() => manager.registerWebview("tab_destroyed_replacement_race", 42)),
          Effect.forkChild({ startImmediately: true }),
        );
        previous.setDestroyed(true);
        previous.debuggerOff.mockImplementationOnce(() => {
          current = replacement.webContents;
          startReplacementRegistration();
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.navigate("tab_destroyed_replacement_race", "https://example.com/");
        const registrationExit = yield* Fiber.await(replacementRegistration);

        expect(Exit.isSuccess(registrationExit)).toBe(true);
        expect(previous.off).toHaveBeenCalled();
        expect(replacement.off).not.toHaveBeenCalled();
        expect(states.at(-1)).toMatchObject({
          webContentsId: 42,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
      }),
    ),
  );

  effectIt.effect("shares an identical in-flight event and lets a changed event win", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFirst!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
        const preview = makeFaviconWebContents({
          changes,
          fetch: (url) =>
            url.endsWith("first.png")
              ? firstResponse
              : Promise.resolve(
                  new Response(new Uint8Array(makeSourcePng()), {
                    headers: { "content-type": "image/png" },
                  }),
                ),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_latest");
        yield* manager.registerWebview("tab_favicon_latest", 42);

        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        faviconUpdated({} as never, ["http://localhost:3200/second.png"] as never);
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);
        resolveFirst(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(preview.fetch).toHaveBeenCalledTimes(2);
        expect(states.filter((state) => state.favicon !== undefined)).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("does not publish a capture invalidated by navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const preview = makeFaviconWebContents({
          changes,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_navigation");
        yield* manager.registerWebview("tab_favicon_navigation", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        preview.listeners.get("did-start-navigation")?.({
          isMainFrame: true,
          isSameDocument: false,
        } as never);
        preview.setUrl("https://example.com/");
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.some((state) => state.favicon !== undefined)).toBe(false);
      }),
    ),
  );

  effectIt.effect("ignores an old capture that completes after webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const initial = makeFaviconWebContents({
          changes,
          id: 42,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        const replacement = makeFaviconWebContents({ changes, id: 43 });
        fromId.mockImplementation((id?: number) =>
          id === 42 ? initial.webContents : id === 43 ? replacement.webContents : null,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_late_replace");
        yield* manager.registerWebview("tab_favicon_late_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => initial.fetch.mock.calls.length === 1);

        yield* manager.registerWebview("tab_favicon_late_replace", 43);
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(
          states.some((state) => state.webContentsId === 43 && state.favicon !== undefined),
        ).toBe(false);
      }),
    ),
  );

  effectIt.effect("treats a reused WebContents id as a new attachment", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        const initial = makeFaviconWebContents({ changes, id: 42 });
        const replacement = makeFaviconWebContents({ changes, id: 42 });
        let active = initial.webContents;
        fromId.mockImplementation(() => active);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_reused_id");
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);

        active = replacement.webContents;
        yield* manager.registerWebview("tab_favicon_reused_id", 42);

        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(initial.off).toHaveBeenCalled();
        expect(replacement.listeners.has("page-favicon-updated")).toBe(true);
      }),
    ),
  );

  const makeAttachingGuest = (id: number) => {
    const listeners = new Map<string, () => void>();
    const attach = vi.fn();
    const detach = vi.fn();
    const sendCommand = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => undefined,
    );
    const detachListeners = new Set<() => void>();
    let chromiumDetaches = 0;
    let destroyed = false;
    const wc = {
      id,
      isDestroyed: () => destroyed,
      isDevToolsOpened: () => {
        if (destroyed) throw new TypeError("Object has been destroyed");
        return false;
      },
      getType: () => "webview",
      getURL: () => "http://localhost:5173/README.md",
      getTitle: () => "README.md",
      isLoadingMainFrame: () => true,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      on: vi.fn(),
      off: vi.fn(),
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => attach.mock.calls.length > detach.mock.calls.length + chromiumDetaches,
        attach,
        detach,
        sendCommand,
        on: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.add(listener);
        },
        off: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.delete(listener);
        },
      },
    };
    /** Chromium dropping the debugger without a detach() call. */
    const chromiumDetach = () => {
      chromiumDetaches += 1;
      // Snapshot like an EventEmitter, so a listener added during emit waits for the next one.
      for (const listener of Array.from(detachListeners)) listener();
    };
    return {
      wc: wc as unknown as Electron.WebContents,
      attach,
      detach,
      sendCommand,
      chromiumDetach,
      destroy: () => {
        destroyed = true;
        listeners.get("destroyed")?.();
      },
    };
  };

  effectIt.effect("reattaches a debugger that Chromium dropped on its own", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAttachingGuest(48);
        fromId.mockReturnValue(guest.wc);
        yield* manager.createTab("tab_detached");
        yield* manager.registerWebview("tab_detached", 48);
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(1);

        guest.chromiumDetach();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("skips a guest destroyed while another guest's session opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const slow = makeAttachingGuest(46);
        let releaseSlow = () => {};
        const slowCommand = new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        slow.sendCommand.mockImplementation(() => slowCommand);
        const queued = makeAttachingGuest(47);

        const slowFiber = yield* manager
          .prepareWebview(slow.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const queuedFiber = yield* manager
          .prepareWebview(queued.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        queued.destroy();
        releaseSlow();

        expect(Exit.isSuccess(yield* Fiber.await(slowFiber))).toBe(true);
        expect(Exit.isSuccess(yield* Fiber.await(queuedFiber))).toBe(true);
        expect(slow.attach).toHaveBeenCalledTimes(1);
        expect(queued.attach).not.toHaveBeenCalled();
      }),
    ),
  );

  const makeAudioWebContents = (id: number) => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const setAudioMuted = vi.fn();
    let audible = false;
    let audibleAfterFirstRead = false;
    let audibleReads = 0;
    return {
      setAudioMuted,
      emitAudioState: (next: boolean) => {
        audible = next;
        listeners.get("audio-state-changed")?.({ audible: next } as never);
      },
      /** Simulate playback starting during attach before the tab owns the guest and can receive its events. */
      startPlayingAfterFirstRead: () => {
        audibleAfterFirstRead = true;
      },
      wc: {
        id,
        isDestroyed: () => false,
        isDevToolsOpened: () => false,
        getType: () => "webview",
        getURL: () => "https://example.com",
        getTitle: () => "Example",
        isLoadingMainFrame: () => false,
        getZoomFactor: () => 1,
        setZoomFactor: vi.fn(),
        setAudioMuted,
        isCurrentlyAudible: () => {
          audibleReads += 1;
          if (audibleAfterFirstRead && audibleReads > 1) return true;
          return audible;
        },
        loadURL: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (...args: never[]) => void) => {
          listeners.set(event, listener);
        }),
        off: vi.fn((event: string) => {
          listeners.delete(event);
        }),
        ipc: { on: vi.fn(), off: vi.fn() },
        send: webviewSend,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setIgnoreMenuShortcuts: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        debugger: {
          isAttached: () => false,
          attach: vi.fn(),
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
        },
      } as never,
    };
  };

  effectIt.effect("reconciles audibility that changed while the guest attached", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        guest.startPlayingAfterFirstRead();
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_window");
        yield* manager.registerWebview("tab_audio_window", 42);
        yield* Effect.yieldNow;

        expect(states.at(-1)?.audible).toBe(true);
      }),
    ),
  );

  effectIt.effect("ignores audio state from a replaced guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_stale");
        yield* manager.registerWebview("tab_audio_stale", 42);
        yield* Effect.yieldNow;

        const replacement = makeAudioWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_audio_stale", 43);
        yield* Effect.yieldNow;

        const publishedBefore = states.length;
        first.emitAudioState(true);
        yield* Effect.yieldNow;

        expect(states.length).toBe(publishedBefore);
        expect(states.at(-1)?.audible).toBe(false);
      }),
    ),
  );

  effectIt.effect("blocks late webview and capture starts during tab close", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("close-race-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(capturePage, 43);
        const replacementListenerSpies = replacementWebContents as unknown as {
          readonly on: ReturnType<typeof vi.fn>;
          readonly off: ReturnType<typeof vi.fn>;
          readonly ipc: { readonly off: ReturnType<typeof vi.fn> };
        };
        fromId.mockImplementation((id) => {
          if (id === 42) return firstWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_close_register_race");
        yield* manager.registerWebview("tab_close_register_race", 42);
        yield* manager.openPictureInPicture("tab_close_register_race");

        const closeCleanupPaused = yield* Deferred.make<void>();
        const continueCloseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          !state.pictureInPicture && state.webContentsId === 42
            ? Deferred.succeed(closeCleanupPaused, undefined).pipe(
                Effect.andThen(Deferred.await(continueCloseCleanup)),
              )
            : Effect.void,
        );

        const closeFiber = yield* manager
          .closeTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(closeCleanupPaused);
        const recreateFiber = yield* manager
          .createTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        const registrationFiber = yield* manager
          .registerWebview("tab_close_register_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        yield* manager.closeTab("tab_close_register_race");
        const recordingExit = yield* Effect.exit(manager.startRecording("tab_close_register_race"));
        yield* Deferred.succeed(continueCloseCleanup, undefined);
        yield* Fiber.join(closeFiber);
        const recreated = yield* Fiber.join(recreateFiber);
        const registrationExit = yield* Fiber.await(registrationFiber);

        for (const exit of [registrationExit, recordingExit] as ReadonlyArray<
          Exit.Exit<unknown, PreviewManager.PreviewManagerError>
        >) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isSuccess(exit)) continue;
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabNotFoundError",
            tabId: "tab_close_register_race",
          });
        }
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        expect(replacementListenerSpies.off).not.toHaveBeenCalled();
        expect(replacementListenerSpies.ipc.off).not.toHaveBeenCalled();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(recreated.webContentsId).toBeNull();
      }),
    ),
  );

  effectIt.effect("keeps a main-frame load failure visible until a retry starts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "http://localhost:5733/";
        let loading = false;
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "localhost:5733",
          isLoadingMainFrame: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const statuses: PreviewManager.PreviewNavStatus[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            statuses.push(state.navStatus);
          }),
        );
        yield* manager.createTab("tab_failed");
        yield* manager.registerWebview("tab_failed", 42);

        listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "https://missing-frame.example/",
          false,
        );
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        listeners.get("did-stop-loading")?.();
        listeners.get("page-title-updated")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)).toEqual({
          kind: "LoadFailed",
          url,
          title: "localhost:5733",
          code: -102,
          description: "ERR_CONNECTION_REFUSED",
        });

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("LoadFailed");

        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");
      }),
    ),
  );

  effectIt.effect("ignores a late cross-origin iframe load once the page has loaded", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        Object.assign(preview.webContents, { isLoading: () => true });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        const loaded = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => void states.push(state)).pipe(
            Effect.andThen(() =>
              state.navStatus.kind === "Success"
                ? Deferred.succeed(loaded, undefined)
                : Effect.void,
            ),
          ),
        );
        yield* manager.createTab("tab_iframe");
        yield* manager.registerWebview("tab_iframe", 42);

        preview.listeners.get("did-start-loading")?.();
        preview.listeners.get("did-stop-loading")?.();
        yield* Deferred.await(loaded);
        expect(states.at(-1)?.navStatus.kind).toBe("Success");
      }),
    ),
  );

  effectIt.effect(
    "refuses private entry during capture and rejects private capture admissions before effects",
    () =>
      withAutofillManager((manager, authorityReady) =>
        Effect.gen(function* () {
          let signalStarted: (() => void) | undefined;
          const started = new Promise<void>((resolve) => {
            signalStarted = resolve;
          });
          let releaseCapture: (() => void) | undefined;
          const image = { toPNG: () => Buffer.from("synthetic-image") };
          const capturePage = vi.fn(
            () =>
              new Promise<typeof image>((resolve) => {
                releaseCapture = () => resolve(image);
                signalStarted?.();
              }),
          );
          const preview = makeFaviconWebContents({ url: "https://example.com/login" });
          const frame = {
            origin: "https://example.com",
            isDestroyed: () => false,
            executeJavaScript: vi.fn(async () => true),
          } as unknown as Electron.WebFrameMain;
          const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
            mainFrame: frame,
            executeJavaScriptInIsolatedWorld: frame.executeJavaScript,
            isFocused: () => true,
            session: { fetch: vi.fn(), getStoragePath: () => "/synthetic/profile-a" },
            capturePage,
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("private_tab");
          yield* manager.registerWebview("private_tab", 42);
          const bound = yield* manager.createTab("private_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          expect(bound.webContentsId).toBe(42);
          yield* Deferred.await(authorityReady);
          const target = yield* manager.getAutofillTarget(wc, frame);
          expect(target).toBeDefined();
          if (!target) return;

          const capture = yield* manager.captureScreenshot("private_tab").pipe(Effect.forkScoped);
          yield* Effect.promise(() => started);
          const refused = yield* Effect.exit(Effect.tryPromise(() => target.enterPrivate()));
          expect(Exit.isFailure(refused)).toBe(true);
          expect(frame.executeJavaScript).not.toHaveBeenCalled();
          releaseCapture?.();
          yield* Fiber.join(capture);

          yield* Effect.promise(() => target.enterPrivate());
          const before = capturePage.mock.calls.length;
          for (const operation of [
            manager.captureScreenshot("private_tab").pipe(Effect.asVoid),
            manager.startRecording("private_tab").pipe(Effect.asVoid),
            manager.openPictureInPicture("private_tab").pipe(Effect.asVoid),
            manager.pickElement("private_tab").pipe(Effect.asVoid),
            manager.setColorScheme("private_tab", "dark").pipe(Effect.asVoid),
          ]) {
            expect(Exit.isFailure(yield* Effect.exit(operation))).toBe(true);
          }
          expect(capturePage).toHaveBeenCalledTimes(before);
          expect(writeFile).toHaveBeenCalledTimes(1);

          yield* Effect.promise(() => target.clearAndResume());
          capturePage.mockImplementation(async () => image);
          yield* manager.captureScreenshot("private_tab");
          expect(capturePage).toHaveBeenCalledTimes(before + 1);
          expect(writeFile).toHaveBeenCalledTimes(2);
        }),
      ),
  );

  effectIt.effect("fences autofill to a focused persistent main-frame document", () =>
    withAutofillManager((manager, authorityReady) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents({ url: "https://example.com/login" });
        let focused = true;
        let storagePath: string | null = "/synthetic/profile-a";
        const frame = {
          origin: "https://example.com",
          isDestroyed: () => false,
          executeJavaScript: vi.fn(async () => true),
        } as unknown as Electron.WebFrameMain;
        const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
          mainFrame: frame,
          executeJavaScriptInIsolatedWorld: frame.executeJavaScript,
          isFocused: () => focused,
          session: { fetch: vi.fn(), getStoragePath: () => storagePath },
        });
        fromId.mockReturnValue(wc);
        yield* manager.createTab("private_tab", {
          serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
        });
        yield* manager.registerWebview("private_tab", 42);
        yield* Deferred.await(authorityReady);
        expect(
          yield* manager.getAutofillTarget(wc, { ...frame } as Electron.WebFrameMain),
        ).toBeUndefined();
        storagePath = null;
        expect(yield* manager.getAutofillTarget(wc, frame)).toBeUndefined();
        storagePath = "/synthetic/profile-a";
        const target = yield* manager.getAutofillTarget(wc, frame);
        expect(target?.current()).toBe(true);
        focused = false;
        expect(target?.current()).toBe(false);
        focused = true;
        preview.listeners.get("did-start-navigation")?.();
        expect(target?.current()).toBe(false);
        if (target) {
          expect(
            Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => target.enterPrivate()))),
          ).toBe(true);
        }
        expect(frame.executeJavaScript).not.toHaveBeenCalled();
      }),
    ),
  );

  for (const boundary of ["focus", "insert"] as const) {
    effectIt.effect(`keeps sharing private until a pending native ${boundary} has settled`, () =>
      withAutofillManager((manager, authorityReady) =>
        Effect.gen(function* () {
          const started = Promise.withResolvers<void>();
          const pending = Promise.withResolvers<boolean>();
          const preview = makeFaviconWebContents({ url: "https://example.com/login" });
          const frame = {
            origin: "https://example.com",
            isDestroyed: () => false,
          } as Electron.WebFrameMain;
          let gatePending = true;
          const execute = vi.fn(async (_world: number, scripts: readonly { code: string }[]) => {
            if (
              boundary === "focus" &&
              scripts[0]?.code === PreviewManager.protonPassAutofillScripts.focusPassword &&
              gatePending
            ) {
              gatePending = false;
              started.resolve();
              return pending.promise;
            }
            if (scripts[0]?.code === PreviewManager.protonPassAutofillScripts.readFilled)
              return ["fake-user", "fake-password"];
            return true;
          });
          const insertText = vi.fn(async (value: string) => {
            if (boundary === "insert" && value === "fake-password" && gatePending) {
              gatePending = false;
              started.resolve();
              await pending.promise;
            }
          });
          const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
            mainFrame: frame,
            isFocused: () => true,
            session: { getStoragePath: () => "/synthetic/profile-a" },
            executeJavaScriptInIsolatedWorld: execute,
            insertText,
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("private_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          yield* manager.registerWebview("private_tab", 42);
          yield* Deferred.await(authorityReady);
          const target = yield* manager.getAutofillTarget(wc, frame);
          if (!target) throw new Error("Missing target");
          yield* Effect.promise(() => target.enterPrivate());
          const releaseRead = target.holdPrivate();
          expect(
            Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => target.clearAndResume()))),
          ).toBe(true);
          releaseRead();
          const fill = yield* Effect.promise(() => target.fill("fake-user", "fake-password")).pipe(
            Effect.forkScoped,
          );
          yield* Effect.promise(() => started.promise);
          expect(
            Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => target.clearAndResume()))),
          ).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(manager.captureScreenshot("private_tab")))).toBe(
            true,
          );
          expect(
            execute.mock.calls.some(
              ([, scripts]) => scripts[0]?.code === PreviewManager.protonPassAutofillScripts.clear,
            ),
          ).toBe(false);
          pending.resolve(true);
          yield* Fiber.join(fill);
          yield* Effect.promise(() => target.clearAndResume());
          expect(target.current()).toBe(false);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                Effect.tryPromise(() => target.fill("fake-user", "fake-password")),
              ),
            ),
          ).toBe(true);
          expect(insertText).toHaveBeenCalledTimes(2);
          expect(execute).toHaveBeenCalledWith(PreviewManager.PROTON_PASS_AUTOFILL_WORLD_ID, [
            { code: PreviewManager.protonPassAutofillScripts.clear },
          ]);
        }),
      ),
    );
  }

  effectIt.effect(
    "keeps a cancelled annotation capture admitted until its pending image drains",
    () =>
      withAutofillManager((manager, authorityReady) =>
        Effect.gen(function* () {
          const overlay = Promise.withResolvers<void>();
          const started = Promise.withResolvers<void>();
          const pending = Promise.withResolvers<{
            getSize: () => { width: number; height: number };
          }>();
          let picked: ((event: unknown, ...args: unknown[]) => void) | undefined;
          const preview = makeFaviconWebContents({ url: "https://example.com/login" });
          const frame = {
            origin: "https://example.com",
            isDestroyed: () => false,
          } as Electron.WebFrameMain;
          const send = vi.fn((channel: string) => {
            if (channel === "preview:start-pick") overlay.resolve();
          });
          const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
            mainFrame: frame,
            isFocused: () => true,
            once: vi.fn(),
            session: { getStoragePath: () => "/synthetic/profile-a" },
            executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
            send,
            ipc: {
              on: (channel: string, listener: typeof picked) => {
                if (channel === "preview:element-picked") picked = listener;
              },
              removeListener: vi.fn(),
              off: vi.fn(),
            },
            capturePage: vi.fn(() => {
              started.resolve();
              return pending.promise;
            }),
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("private_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          yield* manager.registerWebview("private_tab", 42);
          yield* Deferred.await(authorityReady);
          const target = yield* manager.getAutofillTarget(wc, frame);
          if (!target) throw new Error("Missing target");
          const pick = yield* manager.pickElement("private_tab").pipe(Effect.forkScoped);
          yield* Effect.promise(() => overlay.promise);
          picked?.(
            {},
            {
              id: "annotation_1",
              pageUrl: "https://example.com/login",
              pageTitle: "Fake",
              comment: "Fake",
              elements: [],
              regions: [],
              strokes: [],
              styleChanges: [],
              screenshot: null,
              createdAt: "2026-06-11T00:00:00.000Z",
            },
          );
          yield* Effect.promise(() => started.promise);
          expect(
            Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => target.enterPrivate()))),
          ).toBe(true);
          yield* manager.cancelPickElement("private_tab");
          expect(yield* Fiber.join(pick)).toBeNull();
          expect(
            Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => target.enterPrivate()))),
          ).toBe(true);
          pending.resolve({ getSize: () => ({ width: 1, height: 1 }) });
          yield* Effect.yieldNow;
          expect(
            send.mock.calls.some(([channel]) => channel === "preview:annotation-captured"),
          ).toBe(false);
        }),
      ),
  );

  effectIt.effect(
    "keeps sharing private when the real clear script encounters a replaced password node",
    () =>
      withAutofillManager((manager, authorityReady) =>
        Effect.gen(function* () {
          const { document, a, run } = makeAutofillDomFixture();
          document.activeElement = a.username;
          const preview = makeFaviconWebContents({ url: "https://example.com/login" });
          const frame = {
            origin: "https://example.com",
            isDestroyed: () => false,
          } as Electron.WebFrameMain;
          const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
            mainFrame: frame,
            isFocused: () => true,
            session: { getStoragePath: () => "/synthetic/profile-a" },
            executeJavaScriptInIsolatedWorld: async (
              _world: number,
              scripts: readonly { code: string }[],
            ) => run(scripts[0]!.code),
            insertText: async (value: string) => {
              if (document.activeElement) document.activeElement.value = value;
            },
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("private_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          yield* manager.registerWebview("private_tab", 42);
          yield* Deferred.await(authorityReady);
          const target = yield* manager.getAutofillTarget(wc, frame);
          if (!target) throw new Error("Missing target");
          yield* Effect.promise(() => target.enterPrivate());
          yield* Effect.promise(() => target.fill("fake-user", "fake-password"));
          const replacement = a.replacePassword();
          document.activeElement = a.username;
          expect(run(PreviewManager.protonPassAutofillScripts.clear)).toBe(false);
          expect(a.password.value).toBe("fake-password");
          expect(replacement.value).toBe("fake-password");
          expect(
            Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => target.clearAndResume()))),
          ).toBe(true);
          // A second attempt still refuses: failed clear must retain bookkeeping.
          expect(run(PreviewManager.protonPassAutofillScripts.clear)).toBe(false);
          const latest = yield* manager.getAutofillTarget(wc, frame);
          expect(latest?.privateEntry).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(manager.captureScreenshot("private_tab")))).toBe(
            true,
          );
          expect(replacement.value).toBe("fake-password");
        }),
      ),
  );

  for (const mutation of ["refill", "replace", "replacement-channel", "unchanged"] as const) {
    effectIt.effect(
      `verifies retained empty fields and original released connection after ACK: ${mutation}`,
      () =>
        withAutofillManager(
          (manager, ready, peer) =>
            Effect.gen(function* () {
              const { document, a, run } = makeAutofillDomFixture();
              document.activeElement = a.username;
              const verifyStarted = Promise.withResolvers<void>();
              const verifyContinue = Promise.withResolvers<void>();
              const preview = makeFaviconWebContents({ url: "https://example.com/login" });
              const frame = {
                origin: "https://example.com",
                isDestroyed: () => false,
              } as Electron.WebFrameMain;
              const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
                mainFrame: frame,
                isFocused: () => true,
                session: { getStoragePath: () => "/synthetic/profile-a" },
                executeJavaScriptInIsolatedWorld: async (
                  _world: number,
                  scripts: readonly { code: string }[],
                ) => {
                  if (scripts[0]!.code === PreviewManager.protonPassAutofillScripts.verifyClear) {
                    verifyStarted.resolve();
                    await verifyContinue.promise;
                  }
                  return run(scripts[0]!.code);
                },
                insertText: async (value: string) => {
                  if (document.activeElement) document.activeElement.value = value;
                },
              });
              fromId.mockReturnValue(wc);
              yield* manager.createTab("private_tab", {
                serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
              });
              yield* manager.registerWebview("private_tab", 42);
              yield* Deferred.await(ready);
              const target = yield* manager.getAutofillTarget(wc, frame);
              if (!target) throw new Error("Missing target");
              yield* Effect.promise(() => target.enterPrivate());
              yield* Effect.promise(() => target.fill("fake-user", "fake-password"));
              const clearing = yield* Effect.tryPromise(() => target.clearAndResume()).pipe(
                Effect.exit,
                Effect.forkScoped,
              );
              const release = yield* Queue.take(peer.releases);
              expect(a.username.value).toBe("");
              expect(a.password.value).toBe("");
              let replacement: ReturnType<typeof a.replacePassword> | undefined;
              if (mutation === "refill") a.password.value = "fake-restored-password";
              if (mutation === "replace") {
                replacement = a.replacePassword();
                replacement.value = "fake-restored-password";
              }
              yield* peer.connection.handleCommandLine(
                JSON.stringify({ ...(release as object), type: "private-entry-released" }),
              );
              yield* Effect.promise(() => verifyStarted.promise);
              let commandConnection = peer.connection;
              const replacementMessages = yield* Queue.unbounded<string>();
              if (mutation === "replacement-channel") {
                yield* peer.connection.closed;
                commandConnection = peer.host.createConnection();
                yield* commandConnection.events.pipe(
                  Stream.runForEach((bytes) =>
                    Queue.offer(replacementMessages, new TextDecoder().decode(bytes)),
                  ),
                  Effect.forkScoped,
                );
                const attached = yield* Queue.take(replacementMessages);
                expect(JSON.parse(attached).type).toBe("attached");
                expect(peer.host.canRequestPrivateEntry(wc)).toBe(true);
              }
              verifyContinue.resolve();
              const outcome = yield* Fiber.join(clearing);
              if (mutation === "unchanged") {
                expect(Exit.isSuccess(outcome)).toBe(true);
                expect(peer.host.isPrivateEntry(wc)).toBe(false);
                expect(run(PreviewManager.protonPassAutofillScripts.verifyClear)).toBe(true);
              } else {
                expect(Exit.isFailure(outcome)).toBe(true);
                expect(peer.host.isPrivateEntry(wc)).toBe(true);
                expect(
                  Exit.isFailure(yield* Effect.exit(manager.captureScreenshot("private_tab"))),
                ).toBe(true);
                yield* commandConnection.handleCommandLine(
                  JSON.stringify({
                    type: "cdp",
                    threadId: "unit-thread",
                    tabId: "unit-tab",
                    message: JSON.stringify({ id: 777, method: "DOM.getDocument" }),
                  }),
                );
                const response =
                  mutation === "replacement-channel"
                    ? (JSON.parse(yield* Queue.take(replacementMessages)) as { message: string })
                        .message
                    : yield* Queue.take(peer.cdp);
                expect(JSON.parse(response)).toMatchObject({ id: 777, error: { code: -32000 } });
                if (mutation === "refill") {
                  expect(a.password.value).toBe("fake-restored-password");
                  expect(run(PreviewManager.protonPassAutofillScripts.verifyClear)).toBe(false);
                  const retry = yield* manager.getAutofillTarget(wc, frame);
                  if (!retry) throw new Error("Missing explicit retry target");
                  yield* Effect.promise(() => retry.clearAndResume());
                  expect(peer.host.isPrivateEntry(wc)).toBe(false);
                  expect(a.password.value).toBe("");
                  expect(yield* Queue.size(peer.releases)).toBe(0);
                }
                if (mutation === "replace") {
                  expect(replacement?.value).toBe("fake-restored-password");
                  expect(run(PreviewManager.protonPassAutofillScripts.verifyClear)).toBe(false);
                }
              }
            }),
          { holdRelease: true },
        ),
    );
  }

  effectIt.effect("a refused authoritative acquire prevents even the selected provider read", () =>
    withAutofillManager(
      (manager, ready) =>
        Effect.gen(function* () {
          const preview = makeFaviconWebContents({ url: "https://example.com/login" });
          const frame = {
            origin: "https://example.com",
            isDestroyed: () => false,
          } as Electron.WebFrameMain;
          const execute = vi.fn(async () => true);
          const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
            mainFrame: frame,
            isFocused: () => true,
            session: { getStoragePath: () => "/synthetic/profile-a" },
            executeJavaScriptInIsolatedWorld: execute,
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("private_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          yield* manager.registerWebview("private_tab", 42);
          yield* Deferred.await(ready);
          const target = yield* manager.getAutofillTarget(wc, frame);
          if (!target) throw new Error("Missing target");
          const reference = { shareId: "v", itemId: "i", title: "Fake" };
          const credentials = vi.fn(async () => ({
            username: "fake-user",
            password: "fake-password",
          }));
          const service = makeAutofill(
            { vaults: async () => [], logins: async () => [], credentials },
            {
              read: async () => [
                { ...reference, origin: target.origin, partition: target.partition },
              ],
              write: async () => {},
            },
          );
          expect(
            Exit.isFailure(
              yield* Effect.exit(Effect.tryPromise(() => service.fill(target, reference))),
            ),
          ).toBe(true);
          expect(credentials).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
        }),
      { refused: true },
    ),
  );

  effectIt.effect("clears before release ACK and never opens sharing on half-close", () =>
    withAutofillManager(
      (manager, ready, peer) =>
        Effect.gen(function* () {
          const { document, a, run } = makeAutofillDomFixture();
          document.activeElement = a.username;
          const preview = makeFaviconWebContents({ url: "https://example.com/login" });
          const frame = {
            origin: "https://example.com",
            isDestroyed: () => false,
          } as Electron.WebFrameMain;
          const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
            mainFrame: frame,
            isFocused: () => true,
            session: { getStoragePath: () => "/synthetic/profile-a" },
            executeJavaScriptInIsolatedWorld: async (
              _world: number,
              scripts: readonly { code: string }[],
            ) => run(scripts[0]!.code),
            insertText: async (value: string) => {
              if (document.activeElement) document.activeElement.value = value;
            },
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("private_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          yield* manager.registerWebview("private_tab", 42);
          yield* Deferred.await(ready);
          const target = yield* manager.getAutofillTarget(wc, frame);
          if (!target) throw new Error("Missing target");
          yield* Effect.promise(() => target.enterPrivate());
          yield* Effect.promise(() => target.fill("fake-user", "fake-password"));
          const clearing = yield* Effect.exit(
            Effect.tryPromise(() => target.clearAndResume()),
          ).pipe(Effect.forkScoped);
          yield* Queue.take(peer.releases);
          expect(a.username.value).toBe("");
          expect(a.password.value).toBe("");
          expect(clearing.pollUnsafe()).toBeUndefined();
          expect(Exit.isFailure(yield* Effect.exit(manager.captureScreenshot("private_tab")))).toBe(
            true,
          );
          yield* peer.connection.closed;
          yield* peer.connection.closed;
          expect(Exit.isFailure(yield* Fiber.join(clearing))).toBe(true);
          const current = yield* manager.getAutofillTarget(wc, frame);
          expect(current?.privateEntry).toBe(true);
          expect(
            Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => current!.enterPrivate()))),
          ).toBe(true);
        }),
      { holdRelease: true },
    ),
  );

  effectIt.effect("revocation during native focus prevents the next credential insertion", () =>
    withAutofillManager((manager, ready, peer) =>
      Effect.gen(function* () {
        const focused = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<boolean>();
        const preview = makeFaviconWebContents({ url: "https://example.com/login" });
        const frame = {
          origin: "https://example.com",
          isDestroyed: () => false,
        } as Electron.WebFrameMain;
        const inserted = vi.fn(async (_value: string) => {});
        const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
          mainFrame: frame,
          isFocused: () => true,
          session: { getStoragePath: () => "/synthetic/profile-a" },
          insertText: inserted,
          executeJavaScriptInIsolatedWorld: async (
            _world: number,
            scripts: readonly { code: string }[],
          ) => {
            if (scripts[0]?.code === PreviewManager.protonPassAutofillScripts.focusPassword) {
              focused.resolve();
              return pending.promise;
            }
            return true;
          },
        });
        fromId.mockReturnValue(wc);
        yield* manager.createTab("private_tab", {
          serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
        });
        yield* manager.registerWebview("private_tab", 42);
        yield* Deferred.await(ready);
        const target = yield* manager.getAutofillTarget(wc, frame);
        if (!target) throw new Error("Missing target");
        yield* Effect.promise(() => target.enterPrivate());
        const filling = yield* Effect.exit(
          Effect.tryPromise(() => target.fill("fake-user", "fake-password")),
        ).pipe(Effect.forkScoped);
        yield* Effect.promise(() => focused.promise);
        yield* peer.revoke;
        pending.resolve(true);
        expect(Exit.isFailure(yield* Fiber.join(filling))).toBe(true);
        expect(inserted).toHaveBeenCalledTimes(1);
        expect(Exit.isFailure(yield* Effect.exit(manager.captureScreenshot("private_tab")))).toBe(
          true,
        );
      }),
    ),
  );

  effectIt.effect(
    "verifies live login values instead of accepting native insertion acknowledgements",
    () =>
      withAutofillManager((manager, authorityReady) =>
        Effect.gen(function* () {
          const { document, a, run } = makeAutofillDomFixture();
          document.activeElement = a.username;
          let insertValues = false;
          const preview = makeFaviconWebContents({ url: "https://example.com/login" });
          const frame = {
            origin: "https://example.com",
            isDestroyed: () => false,
          } as Electron.WebFrameMain;
          const inserted = vi.fn(async (value: string) => {
            if (insertValues && document.activeElement) document.activeElement.value = value;
          });
          const wc = Object.assign(preview.webContents as unknown as Electron.WebContents, {
            mainFrame: frame,
            isFocused: () => true,
            session: { getStoragePath: () => "/synthetic/profile-a" },
            executeJavaScriptInIsolatedWorld: async (
              _world: number,
              scripts: readonly { code: string }[],
            ) => run(scripts[0]!.code),
            insertText: inserted,
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("private_tab", {
            serverTab: { threadId: "unit-thread", tabId: "unit-tab" },
          });
          yield* manager.registerWebview("private_tab", 42);
          yield* Deferred.await(authorityReady);
          const target = yield* manager.getAutofillTarget(wc, frame);
          if (!target) throw new Error("Missing target");
          const reference = {
            shareId: "fake-vault",
            itemId: "fake-item",
            title: "Synthetic login",
          };
          const cli = vi.fn(async (args: readonly string[]) => {
            await target.assertPrivate();
            if (args[0] === "--version") return "Proton Pass CLI 2.4.2";
            return args.at(-1) === "username" ? "fake-user\n" : "fake-password\n";
          });
          const service = makeAutofill(makeProtonPassProvider(cli), {
            read: async () => [
              { ...reference, origin: target.origin, partition: target.partition },
            ],
            write: async () => {},
          });
          expect(
            Exit.isFailure(
              yield* Effect.exit(Effect.tryPromise(() => service.fill(target, reference))),
            ),
          ).toBe(true);
          expect(inserted).toHaveBeenCalledTimes(2);
          expect(a.username.value).toBe("");
          expect(a.password.value).toBe("");
          expect(Exit.isFailure(yield* Effect.exit(manager.captureScreenshot("private_tab")))).toBe(
            true,
          );
          document.hasFocus = () => false;
          insertValues = true;
          const reads = cli.mock.calls.length;
          expect(
            Exit.isFailure(
              yield* Effect.exit(Effect.tryPromise(() => service.fill(target, reference))),
            ),
          ).toBe(true);
          expect(inserted).toHaveBeenCalledTimes(2);
          expect(cli).toHaveBeenCalledTimes(reads);
          document.hasFocus = () => true;
          yield* Effect.promise(() => service.fill(target, reference));
          expect(a.username.value).toBe("fake-user");
          expect(a.password.value).toBe("fake-password");
          yield* Effect.promise(() => target.clearAndResume());
          expect(a.username.value).toBe("");
          expect(a.password.value).toBe("");
          expect((yield* manager.getAutofillTarget(wc, frame))?.privateEntry).toBe(false);
        }),
      ),
  );

  effectIt.effect("captures a PNG screenshot into browser artifacts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("preview-png");
        const capturePage = vi.fn(async () => ({ toPNG: () => png }));
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com:8443/path?query=value",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(webviewSend).toHaveBeenCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({
            colorScheme: "light",
            primary: "oklch(0.488 0.217 264)",
          }),
        );

        const artifact = yield* manager.captureScreenshot("tab_1");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(mkdir).toHaveBeenCalledWith("/tmp/t3/dev/browser-artifacts");
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
        expect(artifact).toMatchObject({
          tabId: "tab_1",
          mimeType: "image/png",
          sizeBytes: png.byteLength,
        });
        expect(artifact.path).toMatch(
          /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
        );

        // Chromium reports UnknownVizError while a hidden guest warms its
        // first compositor frame, so transient failures are retried.
        capturePage.mockClear();
        capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
        capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
        const retriedFiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(1_000);
        const retriedExit = yield* Fiber.join(retriedFiber);
        expect(Exit.isSuccess(retriedExit)).toBe(true);
        expect(capturePage).toHaveBeenCalledTimes(3);

        capturePage.mockClear();
        const captureCause = new Error("capture failed");
        capturePage.mockRejectedValue(captureCause);
        const failingFiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.join(failingFiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(capturePage).toHaveBeenCalledTimes(3);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "captureScreenshot.capturePage",
          tabId: "tab_1",
          webContentsId: 42,
          cause: captureCause,
        });
      }),
    ),
  );

  effectIt.effect("preserves both screenshots of the same site in the same millisecond", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstPng = Buffer.from("first-preview-png");
        const secondPng = Buffer.from("second-preview-png");
        const pngImage = (png: Buffer) => ({
          toPNG: () => png,
          toJPEG: () => png,
          getSize: () => ({ width: 1280, height: 720 }),
        });
        const capturePage = vi
          .fn<() => Promise<ReturnType<typeof pngImage>>>()
          .mockResolvedValueOnce(pngImage(firstPng))
          .mockResolvedValueOnce(pngImage(secondPng));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const first = yield* manager.captureScreenshot("tab_1");
        const second = yield* manager.captureScreenshot("tab_1");

        expect(first.createdAt).toBe(second.createdAt);
        expect(first.id).not.toBe(second.id);
        expect(first.path).not.toBe(second.path);
        expect(first.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(second.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(writeFile.mock.calls).toEqual([
          [first.path, firstPng],
          [second.path, secondPng],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps every recorded guest unthrottled until its frame capture stops", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const firstWebContents = makeTestPreviewWebContents(capturePage, 41, host);
        const secondWebContents = makeTestPreviewWebContents(capturePage, 42, host);
        const webContentsById = new Map([
          [41, firstWebContents],
          [42, secondWebContents],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_capture_throttling_1");
        yield* manager.createTab("tab_capture_throttling_2");
        yield* manager.registerWebview("tab_capture_throttling_1", 41);
        yield* manager.registerWebview("tab_capture_throttling_2", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        yield* manager.startRecording("tab_capture_throttling_1");
        host.displayMediaHandler()?.({ frame: host.mainFrame }, () => {});
        yield* manager.startRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_1");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("does not commit failed starts and retries throttle restoration", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_capture_throttling_failure");
        yield* manager.registerWebview("tab_capture_throttling_failure", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("start throttling update failed");
        });
        const failedStart = yield* Effect.exit(
          manager.startRecording("tab_capture_throttling_failure"),
        );
        expect(Exit.isFailure(failedStart)).toBe(true);

        yield* manager.startRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false]]);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("stop throttling update failed");
        });
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false], [true], [true]]);

        yield* manager.startRecording("tab_capture_throttling_failure");
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [false],
          [true],
          [true],
          [false],
          [true],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps frame capture closed when a replacement is destroyed during cleanup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const windowEvents = new Map<string, () => void>();
        const host = makeTestHostWebContents();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const guest = makeTestPreviewWebContents(capturePage, 42, host);
        fromId.mockReturnValue(guest);
        yield* manager.createTab("tab_shutdown");
        yield* manager.registerWebview("tab_shutdown", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: (event: string, listener: () => void) => windowEvents.set(event, listener),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);
        yield* manager.startRecording("tab_shutdown");
        const pip = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pip.pictureInPictureWindow;
        });
        yield* manager.openPictureInPicture("tab_shutdown");
        const capturesBeforeClose = capturePage.mock.calls.length;
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          state.pictureInPicture
            ? Effect.void
            : Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
              ),
        );

        windowEvents.get("closed")!();
        yield* Deferred.await(cleanupStarted);
        let destroyed = false;
        const replacement = yield* manager
          .setMainWindow({
            isDestroyed: () => destroyed,
            once: vi.fn(),
            webContents: { setBackgroundThrottling: vi.fn() },
          } as never)
          .pipe(Effect.forkChild({ startImmediately: true }));
        try {
          expect(replacement.pollUnsafe()).toBeUndefined();
          destroyed = true;
        } finally {
          yield* Deferred.succeed(releaseCleanup, undefined);
        }
        yield* Fiber.join(replacement);

        const restart = yield* Effect.exit(manager.startRecording("tab_shutdown"));
        expect(Exit.isFailure(restart)).toBe(true);
        if (Exit.isFailure(restart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(restart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_shutdown",
          });
        }
        expect(capturePage).toHaveBeenCalledTimes(capturesBeforeClose);
        expect(pip.pictureInPictureWindow.isDestroyed()).toBe(true);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);
      }),
    ),
  );

  effectIt.effect("ignores close events from replaced main windows", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeFirstWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_replaced_window_close");
        yield* manager.registerWebview("tab_replaced_window_close", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeFirstWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);

        closeFirstWindow?.();
        yield* manager.startRecording("tab_replaced_window_close");
        expect(firstWindowThrottling).not.toHaveBeenCalled();
        expect(replacementWindowThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_replaced_window_close");
        expect(replacementWindowThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("releases frame capture when the main window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const webContentsById = new Map([
          [42, makeTestPreviewWebContents(capturePage, 42, host)],
          [43, makeTestPreviewWebContents(capturePage, 43, host)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_window_close_recording");
        yield* manager.createTab("tab_window_close_race");
        yield* manager.registerWebview("tab_window_close_recording", 42);
        yield* manager.registerWebview("tab_window_close_race", 43);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.startRecording("tab_window_close_recording");
        expect(firstWindowThrottling.mock.calls).toEqual([[false]]);

        closeMainWindow?.();
        const racedStart = yield* Effect.exit(manager.startRecording("tab_window_close_race"));
        expect(Exit.isFailure(racedStart)).toBe(true);
        if (Exit.isFailure(racedStart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(racedStart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_race",
          });
        }
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);

        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);
        expect(replacementWindowThrottling).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("does not arm recording after the main window closes during warmup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        const capturedImage = {
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(
          () =>
            new Promise<TestCapturedPreviewImage>((resolve) => {
              markWarmupStarted();
              finishWarmup = resolve;
            }),
        );
        const host = makeTestHostWebContents();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42, host));

        yield* manager.createTab("tab_window_close_warmup");
        yield* manager.registerWebview("tab_window_close_warmup", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);

        const start = yield* manager
          .startRecording("tab_window_close_warmup")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        closeMainWindow?.();
        finishWarmup(capturedImage);

        const exit = yield* Fiber.await(start);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_warmup",
          });
        }
        expect(host.session.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("tells the server when a tab it renders natively closes", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.DesktopBrowserHost;
      const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
      const lines = yield* Queue.unbounded<string>();
      yield* host.events.pipe(
        Stream.runForEach((line) => Queue.offer(lines, new TextDecoder().decode(line))),
        Effect.forkScoped,
      );
      const nextType = Queue.take(lines).pipe(
        Effect.map((line) => /"type":"(\w+)"/.exec(line)?.[1]),
      );
      const capturePage = vi.fn(async () => ({
        toPNG: () => Buffer.from("png"),
        toJPEG: () => Buffer.from("jpeg"),
        getSize: () => ({ width: 100, height: 80 }),
      }));
      fromId.mockReturnValue(
        Object.assign(makeTestPreviewWebContents(capturePage, 42), {
          isDevToolsOpened: () => false,
          getUserAgent: () => "Electron",
        }),
      );
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.createTab("tab_1", { serverTab });
      yield* manager.registerWebview("tab_1", 42);
      expect(yield* nextType).toBe("attached");
      yield* manager.closeTab("tab_1");
      expect(yield* nextType).toBe("detached");
    }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect(
    "asks the client to paint a navigated server tab while the agent captures it",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.DesktopBrowserHost;
        const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
        const contents = Object.assign(
          makeTestPreviewWebContents(async () => {
            throw new Error("unused");
          }, 42),
          {
            isDevToolsOpened: () => false,
            getUserAgent: () => "Electron",
            loadURL: vi.fn(async () => undefined),
          },
        );
        const screenshot = Promise.withResolvers<unknown>();
        contents.debugger.sendCommand = vi.fn((method: string) =>
          method === "Page.captureScreenshot" ? screenshot.promise : Promise.resolve(undefined),
        ) as unknown as typeof contents.debugger.sendCommand;
        fromId.mockReturnValue(contents);
        const manager = yield* PreviewManager.PreviewManager;
        const capturing = yield* Queue.unbounded<boolean>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Queue.offer(capturing, state.capturing).pipe(Effect.asVoid),
        );
        const attached = yield* Deferred.make<void>();
        yield* host.events.pipe(
          Stream.runForEach((line) =>
            new TextDecoder().decode(line).includes('"type":"attached"')
              ? Deferred.succeed(attached, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* manager.createTab("tab_1", { serverTab });
        yield* manager.registerWebview("tab_1", 42);
        yield* Deferred.await(attached);
        // Navigating rebuilds the tab's state, which must keep the server tab it answers for.
        yield* manager.navigate("tab_1", "https://example.com/next");
        yield* Queue.clear(capturing);

        yield* host.handleCommandLine(
          JSON.stringify({
            type: "cdp",
            ...serverTab,
            message: JSON.stringify({
              id: 1,
              method: "Page.captureScreenshot",
              sessionId: "t3-preview-page",
            }),
          }),
        );
        expect(yield* Queue.take(capturing)).toBe(true);
        screenshot.resolve({ data: "" });
        expect(yield* Queue.take(capturing)).toBe(false);
      }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("discards a screenshot that resolves after its guest is replaced", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image = {
          toPNG: () => Buffer.from("stale-png"),
          toJPEG: () => Buffer.from("stale-jpeg"),
          getSize: () => ({ width: 100, height: 80 }),
        };
        const pending = Promise.withResolvers<typeof image>();
        const capturePage = vi.fn(() => pending.promise);
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const fiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(0);
        expect(capturePage).toHaveBeenCalledOnce();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 43));
        yield* manager.registerWebview("tab_1", 43);
        pending.resolve(image);
        const exit = yield* Fiber.join(fiber);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(capturePage).toHaveBeenCalledOnce();
        expect(writeFile).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("grants each concurrent preview recording its own tab frame", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstJpeg = Buffer.from("first-recording-frame");
        const secondJpeg = Buffer.from("second-recording-frame");
        const firstCapturePage = vi.fn(async () => ({
          toJPEG: () => firstJpeg,
          getSize: () => ({ width: 800, height: 600 }),
        }));
        const secondCapturePage = vi.fn(async () => ({
          toJPEG: () => secondJpeg,
          getSize: () => ({ width: 390, height: 844 }),
        }));
        const firstSendCommand = vi.fn(async () => undefined);
        const secondSendCommand = vi.fn(async () => undefined);
        const host = makeTestHostWebContents();
        const makeWebContents = (
          id: number,
          capturePage: typeof firstCapturePage,
          sendCommand: typeof firstSendCommand,
        ) =>
          ({
            id,
            mainFrame: { routingId: id },
            hostWebContents: host,
            executeJavaScript: vi.fn(async () =>
              id === 41 ? { width: 800, height: 600 } : { width: 390, height: 844 },
            ),
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => `https://example.com/${id}`,
            getTitle: () => `Example ${id}`,
            isLoadingMainFrame: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setAudioMuted: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            isCurrentlyAudible: () => false,
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setIgnoreMenuShortcuts: vi.fn(),
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
            capturePage,
          }) as never;
        const webContentsById = new Map([
          [41, makeWebContents(41, firstCapturePage, firstSendCommand)],
          [42, makeWebContents(42, secondCapturePage, secondSendCommand)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );
        yield* manager.createTab("tab_1");
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_1", 41);
        yield* manager.registerWebview("tab_2", 42);

        const grants: Array<{ video?: unknown }> = [];
        const takeGrant = () =>
          host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => {
            grants.push(value);
          });

        yield* manager.startRecording("tab_1");
        takeGrant();
        yield* manager.startRecording("tab_2");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 41 } }, { video: { routingId: 42 } }]);

        expect(firstCapturePage).toHaveBeenCalledOnce();
        expect(secondCapturePage).toHaveBeenCalledOnce();
        expect(firstSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );
        expect(secondSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );

        yield* Effect.all([manager.stopRecording("tab_1"), manager.stopRecording("tab_2")], {
          concurrency: 2,
          discard: true,
        });
      }),
    ),
  );

  effectIt.effect("only lets the host frame that armed a recording claim its stream", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        takeGrant({ frameTreeNodeId: 999 });
        takeGrant();

        expect(grants).toEqual([{}, { video: { routingId: 41 } }]);
        yield* manager.stopRecording("tab_race_a");
      }),
    ),
  );

  effectIt.effect("reclaims the arm slot from a destroyed webContents", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant, destroy } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        destroy(41);
        yield* manager.startRecording("tab_race_b");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 42 } }]);

        yield* manager.stopRecording("tab_race_b");
      }),
    ),
  );

  effectIt.effect("gates recording decorations and isolates failed subscribers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const callbacks = new Map<
          string,
          (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined
        >();
        const contents = Object.assign(
          makeTestPreviewWebContents(async () => ({
            toJPEG: () => Buffer.from("frame"),
            getSize: () => ({ width: 800, height: 600 }),
          })),
          {
            ipc: {
              on: (
                channel: string,
                callback: (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined,
              ) => callbacks.set(channel, callback),
              off: vi.fn(),
            },
          },
        );
        fromId.mockReturnValue(contents as never);
        yield* manager.createTab("tab_recording_input");
        yield* manager.registerWebview("tab_recording_input", 42);
        const received: DesktopPreviewRecordingInputEvent[] = [];
        yield* manager.subscribeRecordingInputs(() => Effect.die("renderer unavailable"));
        yield* manager.subscribeRecordingInputs((event) =>
          Effect.sync(() => {
            received.push(event);
          }),
        );
        const send = (input: unknown) =>
          Effect.gen(function* () {
            const fiber = callbacks.get("preview:recording-input")?.(null, input);
            if (fiber) yield* Fiber.join(fiber);
          });
        const key = { type: "key", label: "⌘C", held: true, width: 800 };
        const pointer = {
          type: "pointer",
          phase: "down",
          x: 120,
          y: 80,
          width: 800,
          height: 600,
        };
        yield* send(key);
        expect(received).toEqual([]);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: true,
          showMousePresses: false,
        });
        yield* send(key);
        yield* send(pointer);
        yield* send({ ...key, width: 0 });
        expect(received).toEqual([{ tabId: "tab_recording_input", input: key }]);
        yield* manager.stopRecording("tab_recording_input");
        yield* send(key);
        expect(received).toHaveLength(1);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: false,
          showMousePresses: true,
        });
        yield* send(key);
        yield* send(pointer);
        expect(received.at(-1)).toEqual({ tabId: "tab_recording_input", input: pointer });
        expect(received).toHaveLength(2);
      }),
    ),
  );

  effectIt.effect("continues native recording when the source warmup fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => {
          throw new Error("source is not ready");
        });
        const host = makeTestHostWebContents();
        const webContents = Object.assign(makeTestPreviewWebContents(capturePage, 42, host), {
          executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
        });
        fromId.mockReturnValue(webContents);

        yield* manager.createTab("tab_recording_warmup_failure");
        yield* manager.registerWebview("tab_recording_warmup_failure", 42);

        yield* manager.startRecording("tab_recording_warmup_failure");
        expect(capturePage).toHaveBeenCalledTimes(2);

        const handler = host.displayMediaHandler();
        const streams: Array<{ video?: unknown }> = [];
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        expect(streams).toEqual([{ video: { routingId: 42 } }, {}]);

        yield* manager.stopRecording("tab_recording_warmup_failure");
      }),
    ),
  );

  effectIt.effect("serializes recording source acquisition with webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturedImage = {
          toJPEG: () => Buffer.from("unused-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        const capturePage = vi
          .fn<() => Promise<TestCapturedPreviewImage>>()
          .mockImplementationOnce(
            () =>
              new Promise<TestCapturedPreviewImage>((resolve) => {
                markWarmupStarted();
                finishWarmup = resolve;
              }),
          )
          .mockResolvedValue(capturedImage);
        const initialWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementOn = vi.fn();
        const replacementWebContents = Object.assign(makeTestPreviewWebContents(capturePage, 43), {
          on: replacementOn,
        });
        fromId.mockImplementation((id) => {
          if (id === 42) return initialWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });

        yield* manager.createTab("tab_recording_replacement_race");
        yield* manager.registerWebview("tab_recording_replacement_race", 42);
        const start = yield* manager
          .startRecording("tab_recording_replacement_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        const replacement = yield* manager
          .registerWebview("tab_recording_replacement_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementOn).not.toHaveBeenCalled();

        finishWarmup(capturedImage);
        yield* Fiber.join(start);
        yield* Fiber.join(replacement);
        expect(replacementOn).toHaveBeenCalled();
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_recording_replacement_race");
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [true],
        ]);
      }),
    ),
  );

  effectIt.effect("does not publish picture-in-picture readiness after window teardown", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("closing-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        pictureInPictureWindow.showInactive.mockImplementationOnce(() => {
          pictureInPictureWindow.close();
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_pip_teardown");
        yield* manager.registerWebview("tab_pip_teardown", 42);
        const openExit = yield* Effect.exit(manager.openPictureInPicture("tab_pip_teardown"));

        expect(Exit.hasInterrupts(openExit)).toBe(true);
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.some((state) => state.pictureInPicture)).toBe(false);
        expect(states.at(-1)?.pictureInPicture).toBe(false);
      }),
    ),
  );

  effectIt.effect("closes an initializing picture-in-picture without blocking later opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("serialized-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow: initializingWindow } = makeTestPictureInPictureWindow(
          () => new Promise<void>(() => {}),
        );
        const { pictureInPictureWindow: reopenedWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return initializingWindow;
          })
          .mockImplementationOnce(function () {
            return reopenedWindow;
          });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_concurrent_pip");
        yield* manager.registerWebview("tab_concurrent_pip", 42);

        const firstOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const secondOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const close = yield* manager
          .closePictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(initializingWindow.loadURL).toHaveBeenCalledOnce();
        expect(initializingWindow.close).toHaveBeenCalledOnce();
        const [firstOpenExit, secondOpenExit] = yield* Effect.all([
          Fiber.await(firstOpen),
          Fiber.await(secondOpen),
        ]);
        yield* Fiber.join(close);

        expect(Exit.hasInterrupts(firstOpenExit)).toBe(true);
        expect(Exit.hasInterrupts(secondOpenExit)).toBe(true);
        expect(initializingWindow.showInactive).not.toHaveBeenCalled();
        expect(capturePage).not.toHaveBeenCalled();
        expect(states.at(-1)?.pictureInPicture).toBe(false);

        yield* manager.openPictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.showInactive).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(true);

        yield* manager.closePictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("shows picture-in-picture and keeps capturing after stalled captures", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image = {
          toJPEG: () => Buffer.from("preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const stalledInitial = Promise.withResolvers<typeof image>();
        const stalledLoop = Promise.withResolvers<typeof image>();
        const capturePage = vi
          .fn<() => Promise<typeof image>>()
          .mockImplementationOnce(() => stalledInitial.promise)
          .mockImplementationOnce(() => stalledLoop.promise)
          .mockResolvedValue(image);
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        yield* manager.createTab("tab_pip_stalled_capture");
        yield* manager.registerWebview("tab_pip_stalled_capture", 42);

        try {
          const open = yield* manager
            .openPictureInPicture("tab_pip_stalled_capture")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(1_000);
          expect(pictureInPictureWindow.showInactive).toHaveBeenCalledOnce();
          yield* Fiber.join(open);

          expect(send).not.toHaveBeenCalled();
          yield* TestClock.adjust(500);
          expect(send).toHaveBeenCalled();
        } finally {
          // Release stalled native calls after a failing assertion against unchanged base.
          stalledInitial.resolve(image);
          stalledLoop.resolve(image);
        }
      }),
    ),
  );

  effectIt.effect("rejects picture-in-picture when its webview changes during initialization", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initialCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("stale-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const initialWebContents = makeTestPreviewWebContents(initialCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;
          if (webContentsId === 43) return replacementWebContents;
          return null;
        });
        let resolveLoad: (() => void) | undefined;
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>((resolve) => {
              resolveLoad = resolve;
            }),
        );
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_replaced_webview");
        yield* manager.registerWebview("tab_replaced_webview", 42);
        const open = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(pictureInPictureWindow.loadURL).toHaveBeenCalledOnce();
        expect(resolveLoad).toBeDefined();
        const concurrentOpen = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* manager.registerWebview("tab_replaced_webview", 43);
        resolveLoad?.();

        const openExits = yield* Effect.all([Fiber.await(open), Fiber.await(concurrentOpen)]);
        for (const openExit of openExits) {
          expect(Exit.isFailure(openExit)).toBe(true);
          if (Exit.isSuccess(openExit)) continue;
          const error = Option.getOrThrow(Cause.findErrorOption(openExit.cause));
          expect(error).toMatchObject({
            _tag: "PreviewOperationError",
            operation: "pictureInPicture.validateWebContents",
            tabId: "tab_replaced_webview",
            webContentsId: 42,
          });
        }
        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.showInactive).not.toHaveBeenCalled();
        expect(initialCapturePage).not.toHaveBeenCalled();
        expect(replacementCapturePage).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("keeps element picking active during subframe navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, (...args) => {
              listeners.delete(event);
              listener(...args);
            });
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        listeners.get("did-start-navigation")?.({
          url: "about:blank",
          isSameDocument: false,
          isMainFrame: false,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({
          url: "https://example.com/next",
          isSameDocument: false,
          isMainFrame: true,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect(
    "publishes comment-free selection changes without completing the picker or capturing a screenshot",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let picked: ((event: unknown, ...args: unknown[]) => void) | undefined;
          let listenerReady: (() => void) | undefined;
          const ready = new Promise<void>((resolve) => {
            listenerReady = resolve;
          });
          const capturePage = vi.fn(async () => ({
            toJPEG: () => Buffer.from("frame"),
            getSize: () => ({ width: 10, height: 10 }),
          }));
          fromId.mockReturnValue(
            Object.assign(makeTestPreviewWebContents(capturePage), {
              once: vi.fn(),
              isFocused: () => true,
              focus: vi.fn(),
              ipc: {
                on: vi.fn((channel: string, listener: typeof picked) => {
                  if (channel === "preview:element-picked") {
                    picked = listener;
                    listenerReady?.();
                  }
                }),
                off: vi.fn(),
                removeListener: vi.fn(),
              },
            }) as never,
          );
          const changed = yield* Deferred.make<PreviewManager.PreviewTabState>();
          yield* manager.subscribeStateChanges((_tabId, state) =>
            state.selection ? Deferred.succeed(changed, state).pipe(Effect.asVoid) : Effect.void,
          );
          yield* manager.createTab("tab_selection");
          yield* manager.registerWebview("tab_selection", 42);
          const pick = yield* manager.pickElement("tab_selection").pipe(Effect.forkChild);
          yield* Effect.promise(() => ready);
          expect(picked).toBeDefined();
          const annotation = {
            id: "selection-1",
            pageUrl: "https://example.com",
            pageTitle: null,
            comment: "",
            elements: [],
            regions: [],
            strokes: [],
            styleChanges: [],
            screenshot: null,
            createdAt: "2026-10-28T00:00:00.000Z",
          };
          picked?.({}, annotation, null, "attach", 1, "selection");
          expect((yield* Deferred.await(changed)).selection).toEqual(annotation);
          expect(pick.pollUnsafe()).toBeUndefined();
          expect(capturePage).not.toHaveBeenCalled();
          picked?.({}, annotation, null, "attach", 1, undefined, false);
          expect(yield* Fiber.join(pick)).toEqual({ annotation, submission: "attach" });
          expect(capturePage).not.toHaveBeenCalled();
        }),
      ),
  );

  effectIt.effect("keeps annotation send grants isolated and updates an active pick", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const picked = new Map<number, (event: unknown, ...args: unknown[]) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("annotation"),
          toDataURL: () => "data:image/png;base64,YW5ub3RhdGlvbg==",
          getSize: () => ({ width: 10, height: 10 }),
        }));
        const guests = new Map(
          [42, 43, 44].map(
            (id) =>
              [
                id,
                Object.assign(makeTestPreviewWebContents(capturePage, id), {
                  isFocused: () => true,
                  once: vi.fn(),
                  ipc: {
                    on: vi.fn(
                      (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
                        if (channel === "preview:element-picked") picked.set(id, listener);
                      },
                    ),
                    off: vi.fn(),
                    removeListener: vi.fn(),
                  },
                }),
              ] as const,
          ),
        );
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
        yield* manager.createTab("tab_a");
        yield* manager.createTab("tab_b");
        yield* manager.registerWebview("tab_a", 42);
        yield* manager.registerWebview("tab_b", 43);
        yield* manager.setAnnotationSendEnabled("tab_a", true);
        const annotation = {
          id: "annotation-scopes",
          pageUrl: "https://example.com",
          pageTitle: "Example",
          comment: "Tighten this spacing",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: "2026-09-05T00:00:00.000Z",
        };
        for (const [tabId, id, nextGrant, expected] of [
          ["tab_b", 43, undefined, "attach"],
          ["tab_a", 42, false, "attach"],
          ["tab_a", 42, true, "send"],
        ] as const) {
          const pick = yield* manager.pickElement(tabId).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          if (nextGrant !== undefined) {
            yield* manager.setAnnotationSendEnabled(tabId, nextGrant);
          }
          picked.get(id)?.({}, annotation, null, "send");
          const result = yield* Fiber.join(pick);
          expect(result?.annotation.id).toBe(annotation.id);
          expect(result?.submission).toBe(expected);
        }
        yield* manager.registerWebview("tab_a", 44);
        const replacementPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(replacementPick))?.submission).toBe("send");
        yield* manager.closeTab("tab_a");
        yield* manager.createTab("tab_a");
        yield* manager.registerWebview("tab_a", 44);
        const reopenedPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(reopenedPick))?.submission).toBe("attach");
      }),
    ),
  );

  describe("annotation screenshots", () => {
    const captureAnnotation = (
      cropRect: PreviewAnnotationRect | null,
      targets: Partial<Pick<PreviewAnnotationPayload, "elements" | "regions" | "strokes">> = {},
      emptyImage?: "viewport" | "crop",
    ) =>
      withManager((manager) =>
        Effect.gen(function* () {
          let onPicked: ((event: unknown, ...args: unknown[]) => void) | undefined;
          const crop = vi.fn((rect: Electron.Rectangle) => ({
            isEmpty: () => emptyImage === "crop",
            getSize: () =>
              emptyImage === "crop"
                ? { width: 0, height: 0 }
                : { width: rect.width, height: rect.height },
            toDataURL: () => (emptyImage === "crop" ? "data:," : "data:image/png;base64,cropped"),
          }));
          const capturePage = vi.fn(async () => ({
            isEmpty: () => emptyImage === "viewport",
            getSize: () =>
              emptyImage === "viewport" ? { width: 0, height: 0 } : { width: 2000, height: 1200 },
            toJPEG: () => Buffer.from("unused"),
            toDataURL: () => (emptyImage === "viewport" ? "data:," : "data:image/png;base64,full"),
            crop,
          }));
          fromId.mockReturnValue(
            Object.assign(makeTestPreviewWebContents(capturePage), {
              isFocused: () => true,
              once: vi.fn(),
              ipc: {
                on: vi.fn((channel: string, listener: typeof onPicked) => {
                  if (channel === "preview:element-picked") onPicked = listener;
                }),
                off: vi.fn(),
                removeListener: vi.fn(),
              },
            }),
          );

          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          onPicked?.(
            {},
            {
              id: "annotation_1",
              pageUrl: "https://example.com",
              pageTitle: "Example",
              comment: "Tighten this spacing",
              elements: [],
              regions: [],
              strokes: [],
              ...targets,
              styleChanges: [],
              screenshot: null,
              createdAt: "2026-06-11T00:00:00.000Z",
            },
            cropRect,
            "attach",
            2,
          );

          const result = yield* Fiber.join(pick);
          expect(capturePage).toHaveBeenCalledExactlyOnceWith();
          expect(result?.annotation.comment).toBe("Tighten this spacing");
          expect(result?.submission).toBe("attach");
          return { result, crop };
        }),
      );

    effectIt.effect("clips a partially visible selection to the captured viewport", () =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(
          { x: -40, y: 570, width: 240, height: 110 },
          { regions: [{ id: "region_1", rect: { x: -20, y: 590, width: 200, height: 70 } }] },
        );
        expect(crop).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 1140, width: 400, height: 60 });
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: 400,
          height: 60,
        });
      }),
    );

    effectIt.effect.each([
      {
        name: "an offscreen crop without individual target bounds",
        cropRect: { x: 1010, y: 40, width: 100, height: 70 },
        regions: [],
      },
      {
        name: "padding overlapping the viewport while its target is offscreen",
        cropRect: { x: 40, y: -100, width: 240, height: 110 },
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
      {
        name: "a union spanning the viewport with both targets offscreen",
        cropRect: { x: -230, y: 40, width: 1460, height: 110 },
        regions: [
          { id: "region_1", rect: { x: -210, y: 60, width: 200, height: 70 } },
          { id: "region_2", rect: { x: 1010, y: 60, width: 200, height: 70 } },
        ],
      },
      {
        name: "an offscreen target when crop bounds are missing",
        cropRect: null,
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
    ])("does not attach $name", ({ cropRect, regions }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, { regions });
        expect(crop).not.toHaveBeenCalled();
        expect(result?.annotation.screenshot).toBeNull();
        expect(result?.screenshotFailed).toBe(true);
      }),
    );

    // regression: #18441 zero-area strokes on the viewport edge must still get a screenshot crop
    effectIt.effect.each([
      {
        name: "zero-width SVG line on the left edge",
        rect: { x: 0, y: 60, width: 0, height: 70 },
        cropRect: { x: -20, y: 40, width: 40, height: 110 },
        expectedCrop: { x: 0, y: 80, width: 40, height: 220 },
      },
      {
        name: "zero-height SVG line on the top edge",
        rect: { x: 60, y: 0, width: 70, height: 0 },
        cropRect: { x: 40, y: -20, width: 110, height: 40 },
        expectedCrop: { x: 80, y: 0, width: 220, height: 40 },
      },
    ])("captures a stroked $name", ({ rect, cropRect, expectedCrop }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, {
          elements: [
            {
              id: "element_1",
              rect,
              element: {
                pageUrl: "https://example.com",
                pageTitle: "Example",
                tagName: "line",
                selector: "svg > line",
                htmlPreview: '<line stroke="black" stroke-width="2" />',
                componentName: null,
                source: null,
                stack: [],
                styles: "stroke: black; stroke-width: 2px;",
                pickedAt: "2026-06-11T00:00:00.000Z",
              },
            },
          ],
        });
        expect(crop).toHaveBeenCalledExactlyOnceWith(expectedCrop);
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: expectedCrop.width,
          height: expectedCrop.height,
        });
      }),
    );
  });

  effectIt.effect("reveals only files inside the configured browser artifact directory", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

        expect(showItemInFolder).toHaveBeenCalledWith(
          "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
        );
        const exit = yield* Effect.exit(manager.revealArtifact("/tmp/t3/dev/settings.json"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);
      }),
    ),
  );
});

function makeAutofillDomFixture() {
  const document: { activeElement?: FakeInput; hasFocus: () => boolean; visibilityState: string } =
    {
      hasFocus: () => true,
      visibilityState: "visible",
    };
  class FakeInput {
    disabled = false;
    autocomplete = "";
    isConnected = true;
    ownerDocument = document;
    private storedValue = "";
    type: string;
    form: {
      querySelectorAll: (selector: string) => FakeInput[];
      isConnected: boolean;
      ownerDocument: typeof document;
      contains: (field: FakeInput) => boolean;
    };
    constructor(type: string, form: FakeInput["form"]) {
      this.type = type;
      this.form = form;
    }
    get value() {
      return this.storedValue;
    }
    set value(value: string) {
      this.storedValue = value;
    }
    getClientRects() {
      return [1];
    }
    focus() {
      document.activeElement = this;
    }
    select() {}
    dispatchEvent(_event: Event) {
      return true;
    }
  }
  const form = () => {
    const fields: FakeInput[] = [];
    const owner = {
      isConnected: true,
      ownerDocument: document,
      contains: (field: FakeInput) => fields.includes(field),
      querySelectorAll: (selector: string) =>
        fields.filter((field) =>
          selector === 'input[type="password"]'
            ? field.type === "password"
            : selector.includes("autocomplete")
              ? false
              : field.type === "text",
        ),
    };
    const username = new FakeInput("text", owner);
    const password = new FakeInput("password", owner);
    fields.push(username, password);
    return {
      username,
      password,
      replacePassword() {
        const replacement = new FakeInput(password.type, owner);
        replacement.value = password.value;
        password.isConnected = false;
        fields[fields.indexOf(password)] = replacement;
        return replacement;
      },
    };
  };
  const a = form();
  const b = form();
  const isolated = NodeVM.createContext({ document, HTMLInputElement: FakeInput, Event });
  const run = (code: string): unknown => NodeVM.runInContext(code, isolated);
  return { document, a, b, run };
}

it("refuses a different form until isolated bookkeeping clears the original revealed fields", () => {
  const { document, a, b, run } = makeAutofillDomFixture();
  document.activeElement = a.username;
  expect(run(PreviewManager.protonPassAutofillScripts.prepare)).toBe(true);
  // Link -> fill on the same pair remains supported.
  expect(run(PreviewManager.protonPassAutofillScripts.prepare)).toBe(true);
  a.username.value = "fake-user";
  a.password.value = "fake-password";
  a.password.type = "text";
  document.activeElement = b.username;
  expect(run(PreviewManager.protonPassAutofillScripts.prepare)).toBe(false);
  expect(run(PreviewManager.protonPassAutofillScripts.clear)).toBe(true);
  expect(run(PreviewManager.protonPassAutofillScripts.prepare)).toBe(false);
  expect(run(PreviewManager.protonPassAutofillScripts.verifyClear)).toBe(true);
  expect(a.username.value).toBe("");
  expect(a.password.value).toBe("");
  expect(run(PreviewManager.protonPassAutofillScripts.prepare)).toBe(true);
});
