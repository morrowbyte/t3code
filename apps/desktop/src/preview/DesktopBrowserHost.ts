// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/** The manager owns the single debugger attachment; the relay shares it. */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  DesktopBrowserPrivateEntryResponse,
  PreviewViewportSetting,
  type DesktopBrowserTabRestoration,
  type DesktopBrowserPrivateEntryAttachment,
  type DesktopBrowserPrivateEntryRequest,
  type DesktopBrowserEvent as DesktopBrowserEventType,
  type PreviewAutomationLoadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  createCdpRelayConnection,
  createCdpRelaySessionState,
  type CdpRelayConnection,
} from "./CdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodePrivateResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(DesktopBrowserPrivateEntryResponse),
);
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const decodeViewportSetting = Schema.decodeUnknownSync(PreviewViewportSetting);
const lineEncoder = new TextEncoder();
const decodePrivateCdpRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.Number, sessionId: Schema.optionalKey(Schema.String) }),
  ),
);
const encodePrivateCdpError = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
      sessionId: Schema.optionalKey(Schema.String),
    }),
  ),
);
/** CDP commands through which an agent clicks, types, or navigates the page. */
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
/** The same commands as above, by method, for the relay's sends. */
const AGENT_INPUT_METHOD = /^(?:Input\.|Page\.navigate$|Runtime\.(?:evaluate|callFunctionOn)$)/;
const AGENT_INPUT_WINDOW_MS = 5_000;
/** A viewer's pointer travelling over the stream activates nothing on the page. */
const POINTER_TRAVEL = new Set<unknown>(["mouseMoved", "mouseWheel"]);
const FOCUS_IDLE = "5 seconds";
/** How long a screenshot waits for the client to draw its guest at full detail. */
const CAPTURE_DRAW_WAIT = "1 second";
/** Well inside the server's 10 s DESKTOP_ATTACH_TIMEOUT, for a first page that never reports it is up. */
const FIRST_PAGE_TIMEOUT = "5 seconds";
const ERR_ABORTED = -3;

export interface DesktopBrowserTabKey {
  /** Omitted only for the legacy primary backend's FD connection. */
  readonly environmentId?: string | undefined;
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
  readonly getRestoration?: () => DesktopBrowserTabRestoration | undefined;
  readonly setViewport?: (setting: PreviewViewportSetting) => Promise<void>;
  readonly captureRevision?: () => number;
  readonly acquireCaptureHold?: () => () => void;
  /** Runs after the server clears the tab's cookies, so state kept beside them goes too. */
  readonly cookiesCleared?: () => Promise<void>;
}

const keyOf = ({ environmentId, threadId, tabId }: DesktopBrowserTabKey) =>
  JSON.stringify([environmentId ?? null, threadId, tabId]);
const wireKey = ({ threadId, tabId }: DesktopBrowserTabKey) => ({ threadId, tabId });

interface TargetConnection {
  readonly environmentId: string | undefined;
  readonly token: symbol;
  readonly epoch: string;
  readonly proxyUrl: string | undefined;
  readonly close: (announce?: boolean) => Promise<void>;
  readonly networkSessions: Set<Electron.Session>;
  readonly agentTurns: Set<string>;
}

export interface DesktopBrowserConnection {
  readonly events: Stream.Stream<Uint8Array>;
  readonly handleCommandLine: (line: string) => Effect.Effect<void>;
  readonly closed: Effect.Effect<void>;
  readonly dispatchCommandLine?: (
    line: string,
  ) => Effect.Effect<{ readonly settled: Promise<void> } | undefined>;
}

export interface NativePrivateEntryLease {
  current(): boolean;
  release(): Promise<NativePrivateEntryResume>;
}
/** Local authority to resume after field verification; never crosses the wire. */
export interface NativePrivateEntryResume {
  current(): boolean;
}
interface LeaseState {
  readonly requestId: string;
  readonly leaseId: string;
  readonly generation: number;
  active: boolean;
}
interface PendingControl {
  readonly request: DesktopBrowserPrivateEntryRequest;
  readonly timer: Fiber.Fiber<void>;
  readonly accept: (lease?: NativePrivateEntryLease) => void;
  readonly reject: () => void;
}

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  relaySessions: {
    readonly connection: symbol | null;
    readonly state: ReturnType<typeof createCdpRelaySessionState>;
  } | null;
  attachment: DesktopBrowserPrivateEntryAttachment | null;
  lease: LeaseState | null;
  releasedLease: LeaseState | null;
  pending: PendingControl | null;
  readonly cancelled: Set<string>;
  /** Where the server wants this tab's downloads; null keeps Electron's own handling. */
  screenshotTurn: object | null;
  /** Each keeps the guest painting while whoever queued it still waits, and focused while `held`. */
  readonly waitingScreenshots: Array<{
    readonly start: () => void;
    readonly live: () => boolean;
    held: boolean;
  }>;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  /** When the agent last drove the page with no person's input through a viewer since. */
  agentLedAt: number;
  focusEmulated: boolean;
  focusChange: Promise<void> | null;
  focusUses: number;
  /** Each pending command, by the extra session waiting on it; the main connection's have none. */
  readonly focusPending: Map<object, string | undefined>;
  /** Screenshots Chromium was sent and has not answered; each keeps its wake lock until then. */
  readonly capturing: Set<object>;
  /** Whether the client keeps the guest painting, as published on `painting`. */
  painting: boolean;
  /**
   * Driven by the agent since its thread's last turn ended or the guest last throttled. A
   * turn's start can reach us after its first command, so this holds focus once it does.
   */
  agentUsed: boolean;
  focusReleasing: boolean;
  /** The sessions sharing the guest's one Chromium screencast; it stops with the last of them. */
  readonly screencasts: Map<string | undefined, { started: boolean; pending: number }>;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
  readonly onNewDocument: () => void;
  /** Stops waiting for the first page; set until the tab is announced. */
  stopWaiting: (() => void) | null;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    readonly events: Stream.Stream<Uint8Array>;
    readonly createConnection: (
      targetEnvironmentId?: string,
      proxyUrl?: string,
    ) => DesktopBrowserConnection;
    readonly configureTargetSession: (
      environmentId: string | undefined,
      session: Electron.Session,
      required?: boolean,
    ) => Promise<void>;
    readonly hostedEnvironmentIds: () => ReadonlyArray<string>;
    readonly hostedEnvironmentsChanged: Stream.Stream<ReadonlyArray<string>>;
    /** One line from the backend's browser control fd. */
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    readonly detach: (key: DesktopBrowserTabKey) => void;
    readonly loadFailed: (key: DesktopBrowserTabKey, failure: PreviewAutomationLoadError) => void;
    readonly setShown: (key: DesktopBrowserTabKey, shown: boolean | undefined) => void;
    /** Whether the client draws the guest at full detail while it is captured. */
    readonly setCaptureDrawn: (key: DesktopBrowserTabKey, drawn: boolean | undefined) => void;
    /** Native credential entry blocks every relay operation, including observations. */
    readonly setPrivateEntry: (source: Electron.WebContents, active: boolean) => void;
    readonly isPrivateEntry: (source: Electron.WebContents) => boolean;
    readonly privateEntryChanges: Stream.Stream<{
      readonly source: Electron.WebContents;
      readonly active: boolean;
    }>;
    readonly canRequestPrivateEntry: (source: Electron.WebContents) => boolean;
    readonly acquirePrivateEntry: (
      source: Electron.WebContents,
    ) => Promise<NativePrivateEntryLease>;
    /**
     * Whether a server tab's download came from the person at this desktop:
     * the server sent the page no input just before it started.
     */
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    /** Whether what the page does now follows the agent's input, not a viewer's. */
    readonly agentLedPage: (source: Electron.WebContents) => boolean;
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
    /** Whether a guest needs its frames painted while the panel hides it. */
    readonly painting: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly active: boolean;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const outbox = yield* PubSub.unbounded<{
    connection: symbol | null;
    event: DesktopBrowserEventType;
  }>();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const painting = yield* PubSub.unbounded<{
    readonly key: DesktopBrowserTabKey;
    readonly active: boolean;
  }>();
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const tabs = new Map<string, AttachedTab>();
  const connections = new Map<string | undefined, TargetConnection>();
  const hostedEnvironmentsChanged = yield* PubSub.unbounded<ReadonlyArray<string>>();
  const hostedEnvironmentIds = () =>
    [...connections.keys()].filter((id): id is string => id !== undefined);
  const announceEnvironments = () =>
    runFork(PubSub.publish(hostedEnvironmentsChanged, hostedEnvironmentIds()));
  const networkSessions = new WeakMap<
    Electron.Session,
    { connection: TargetConnection; proxyUrl: string; ready: Promise<void>; allowed: boolean }
  >();
  const networkGuards = new WeakSet<Electron.Session>();
  const configureTargetSession = (
    environmentId: string | undefined,
    session: Electron.Session,
    required = false,
  ): Promise<void> => {
    const connection = connections.get(environmentId);
    if (!connection?.proxyUrl)
      return required
        ? Promise.reject(new Error("The remote browser network is disconnected."))
        : Promise.resolve();
    const proxyUrl = connection.proxyUrl;
    const previous = networkSessions.get(session);
    if (previous?.connection === connection && previous.proxyUrl === proxyUrl)
      return previous.ready;
    if (!networkGuards.has(session)) {
      session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (_request, callback) => {
        const current = networkSessions.get(session);
        callback({
          cancel:
            !current?.allowed ||
            connections.get(current.connection.environmentId) !== current.connection,
        });
      });
      networkGuards.add(session);
    }
    if (previous) previous.allowed = false;
    connection.networkSessions.add(session);
    const ready = (previous?.ready.catch(() => undefined) ?? Promise.resolve()).then(async () => {
      await session.setProxy({
        mode: "fixed_servers",
        proxyRules: proxyUrl,
        proxyBypassRules: "<-loopback>",
      });
      await session.closeAllConnections();
      if (connections.get(environmentId) !== connection)
        throw new Error("The browser network target changed.");
      current.allowed = true;
    });
    const current = { connection, proxyUrl, ready, allowed: false };
    networkSessions.set(session, current);
    void ready.catch(() => {
      if (networkSessions.get(session) === current) networkSessions.delete(session);
    });
    return ready;
  };
  const privateContents = new WeakSet<Electron.WebContents>();
  const privateEntryChanges = yield* PubSub.unbounded<{
    readonly source: Electron.WebContents;
    readonly active: boolean;
  }>();
  const updatePrivateEntry = (source: Electron.WebContents, active: boolean) => {
    if (active) privateContents.add(source);
    else privateContents.delete(source);
    for (const tab of tabs.values()) {
      if (tab.debuggee.webContents !== source) continue;
      // Old asynchronous replies must remain invalid even after explicit resume.
      dropRelay(tab);
      tab.downloadDirectory = null;
      tab.pendingDownloadGuid = null;
    }
  };
  const setPrivateEntry = (source: Electron.WebContents, active: boolean) => {
    const changed = privateContents.has(source) !== active;
    updatePrivateEntry(source, active);
    if (changed) runFork(PubSub.publish(privateEntryChanges, { source, active }));
  };
  const emit = (event: DesktopBrowserEventType, environmentId?: string) =>
    runFork(
      PubSub.publish(outbox, { connection: connections.get(environmentId)?.token ?? null, event }),
    );

  const unavailable = () => new Error("Native private entry is unavailable");
  const attachedFor = (source: Electron.WebContents) =>
    [...tabs.values()].find((tab) => tab.debuggee.webContents === source);
  const isCurrentAttachment = (tab: AttachedTab) => {
    const connection = connections.get(tab.key.environmentId);
    const channelEpoch = connection?.epoch ?? null;
    const activeConnection = connection?.token ?? null;
    return (
      channelEpoch !== null &&
      activeConnection !== null &&
      tab.attachment?.channelEpoch === channelEpoch &&
      tabs.get(keyOf(tab.key)) === tab &&
      !tab.debuggee.webContents.isDestroyed()
    );
  };
  const cancel = (
    tab: AttachedTab,
    request: Pick<DesktopBrowserPrivateEntryRequest, "channelEpoch" | "attachmentId" | "requestId">,
  ) => {
    tab.cancelled.add(request.requestId);
    if (tab.cancelled.size > 8) tab.cancelled.delete(tab.cancelled.values().next().value!);
    if (isCurrentAttachment(tab))
      emit(
        {
          type: "private-entry-cancel",
          ...wireKey(tab.key),
          channelEpoch: request.channelEpoch,
          attachmentId: request.attachmentId,
          requestId: request.requestId,
        },
        tab.key.environmentId,
      );
  };
  const invalidate = (tab: AttachedTab) => {
    tab.releasedLease = null;
    if (tab.pending) {
      const pending = tab.pending;
      tab.pending = null;
      pending.timer.interruptUnsafe();
      if (pending.request.type === "private-entry-acquire") cancel(tab, pending.request);
      pending.reject();
    }
    if (tab.lease) {
      tab.lease.active = false;
      setPrivateEntry(tab.debuggee.webContents, true);
      tab.lease = null;
    }
    dropRelay(tab);
  };
  const request = (
    tab: AttachedTab,
    message: DesktopBrowserPrivateEntryRequest,
  ): Promise<NativePrivateEntryLease | undefined> =>
    new Promise((resolve, reject) => {
      if (!isCurrentAttachment(tab) || tab.pending) {
        reject(unavailable());
        return;
      }
      tab.releasedLease = null;
      const timer = runFork(
        Effect.sleep("5 seconds").pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (tab.pending?.request !== message) return;
              tab.pending = null;
              setPrivateEntry(tab.debuggee.webContents, true);
              if (message.type === "private-entry-acquire") cancel(tab, message);
              if (tab.lease) tab.lease.active = false;
              reject(unavailable());
            }),
          ),
        ),
      );
      tab.pending = {
        request: message,
        timer,
        accept: resolve,
        reject: () => reject(unavailable()),
      };
      emit(message, tab.key.environmentId);
    });
  const leaseHandle = (tab: AttachedTab, lease: LeaseState): NativePrivateEntryLease => {
    const connection = connections.get(tab.key.environmentId)?.token ?? null;
    const attachment = tab.attachment;
    return {
      current: () => isCurrentAttachment(tab) && tab.lease === lease && lease.active,
      async release() {
        if (
          !isCurrentAttachment(tab) ||
          connections.get(tab.key.environmentId)?.token !== connection ||
          tab.attachment !== attachment ||
          tab.lease !== lease ||
          !lease.active ||
          !attachment ||
          tab.pending
        )
          throw unavailable();
        // The new operation ID is ACKed with the OLD released lease/generation.
        await request(tab, {
          type: "private-entry-release",
          ...wireKey(tab.key),
          ...attachment,
          requestId: NodeCrypto.randomUUID(),
          leaseId: lease.leaseId,
          generation: lease.generation,
        });
        const resume: NativePrivateEntryResume = {
          current: () =>
            connections.get(tab.key.environmentId)?.token === connection &&
            tab.attachment === attachment &&
            isCurrentAttachment(tab) &&
            tab.releasedLease === lease &&
            tab.lease === null &&
            tab.pending === null,
        };
        if (!resume.current()) throw unavailable();
        return resume;
      },
    };
  };
  const acquirePrivateEntry = async (source: Electron.WebContents) => {
    const tab = attachedFor(source);
    if (
      !tab ||
      !isCurrentAttachment(tab) ||
      !tab.attachment ||
      tab.pending ||
      tab.lease ||
      privateContents.has(source)
    )
      throw unavailable();
    const result = await request(tab, {
      type: "private-entry-acquire",
      ...wireKey(tab.key),
      ...tab.attachment,
      requestId: NodeCrypto.randomUUID(),
    });
    if (!result?.current()) throw unavailable();
    return result;
  };
  const handlePrivateResponse = (
    response: DesktopBrowserPrivateEntryResponse,
    environmentId: string | undefined,
  ) => {
    const tab = tabs.get(keyOf({ ...response, environmentId }));
    if (
      !tab ||
      !isCurrentAttachment(tab) ||
      !tab.attachment ||
      response.channelEpoch !== tab.attachment.channelEpoch ||
      response.attachmentId !== tab.attachment.attachmentId
    )
      return;
    if (response.type === "private-entry-revoked") {
      const lease = tab.lease;
      if (
        !lease ||
        response.requestId !== lease.requestId ||
        response.leaseId !== lease.leaseId ||
        response.generation !== lease.generation
      )
        return;
      invalidate(tab);
      return;
    }
    const pending = tab.pending;
    if (!pending || pending.request.requestId !== response.requestId) {
      if (response.type === "private-entry-granted" && tab.cancelled.has(response.requestId))
        cancel(tab, response);
      return;
    }
    const incomingGrant =
      response.type === "private-entry-granted" && pending.request.type === "private-entry-acquire";
    const incomingRelease =
      response.type === "private-entry-released" &&
      pending.request.type === "private-entry-release" &&
      response.leaseId === pending.request.leaseId &&
      response.generation === pending.request.generation &&
      tab.lease?.active === true &&
      tab.lease.leaseId === response.leaseId &&
      tab.lease.generation === response.generation;
    const incomingRefusal = response.type === "private-entry-refused";
    if (!incomingGrant && !incomingRelease && !incomingRefusal) return;
    pending.timer.interruptUnsafe();
    tab.pending = null;
    if (incomingGrant) {
      const lease: LeaseState = {
        requestId: response.requestId,
        leaseId: response.leaseId,
        generation: response.generation,
        active: true,
      };
      tab.lease = lease;
      pending.accept(leaseHandle(tab, lease));
    } else if (incomingRelease) {
      tab.releasedLease = tab.lease;
      if (tab.lease) tab.lease.active = false;
      tab.lease = null;
      pending.accept();
    } else {
      if (pending.request.type === "private-entry-release" && tab.lease) tab.lease.active = false;
      if (pending.request.type === "private-entry-acquire") cancel(tab, pending.request);
      pending.reject();
    }
  };
  // Visibility may be published before the debugger attaches.
  const shownTabs = new Map<string, boolean>();
  const drawnTabs = new Set<string>();
  const drawWaiters = new Map<string, Set<() => void>>();

  const nextScreenshot = (tab: AttachedTab) => {
    tab.screenshotTurn = null;
    tab.waitingScreenshots.shift()?.start();
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  /**
   * Chromium below 157 crashes the whole app when a guest's renderer exits with a
   * screenshot copy in flight (crbug.com/567321049). Overlapping screenshots make that
   * far likelier, and one the server gave up on stays pending in Chromium, so each guest
   * gets one at a time. One whose relay or session has since gone is dropped unsent.
   */
  const takeScreenshot = (
    tab: AttachedTab,
    relay: CdpRelayConnection,
    ownerLive: () => boolean,
    /** Sends only while `current` holds; holds focus only while `held`. */
    capture: (current: () => boolean, held: boolean) => Promise<unknown>,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const live = () => tab.relay === relay && ownerLive();
      const waiting = {
        start: () => {
          if (!live()) {
            reject(new Error("The preview connection that asked for this screenshot closed."));
            nextScreenshot(tab);
            return;
          }
          const turn = {};
          tab.screenshotTurn = turn;
          capture(() => tab.screenshotTurn === turn && live(), waiting.held)
            .finally(() => {
              if (tab.screenshotTurn === turn) nextScreenshot(tab);
            })
            .then(resolve, reject);
        },
        live,
        held: true,
      };
      if (tab.screenshotTurn === null) waiting.start();
      else {
        // The one ahead may be abandoned mid-capture; it needs frames to finish and free its turn.
        tab.waitingScreenshots.push(waiting);
        setFocusEmulation(tab, true);
        syncPainting(tab);
      }
    });

  /**
   * Chromium counts a focus-emulated guest as captured, so a guest the panel hides would
   * never throttle. Without it, a hidden guest paints no frames and focus() fires no focus
   * events, so the guest is emulated focused while the server drives it or streams it.
   */
  const setFocusEmulation = (tab: AttachedTab, enabled: boolean) => {
    if (tab.focusEmulated === enabled) return;
    tab.focusEmulated = enabled;
    // A guest that refuses it, or a debugger already gone, behaves as unfocused.
    const change: Promise<void> = tab.debuggee.debugger
      .sendCommand("Emulation.setFocusEmulationEnabled", { enabled })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (tab.focusChange === change) tab.focusChange = null;
      });
    tab.focusChange = change;
  };

  const waitingHolds = (tab: AttachedTab) =>
    tab.waitingScreenshots.some((waiting) => waiting.held && waiting.live());

  const releaseFocusWhenIdle = (tab: AttachedTab) => {
    if (tab.focusReleasing) return;
    tab.focusReleasing = true;
    runFork(
      Effect.gen(function* () {
        let uses: number;
        do {
          uses = tab.focusUses;
          yield* Effect.sleep(FOCUS_IDLE);
        } while (uses !== tab.focusUses);
        tab.focusReleasing = false;
        // The last pending command to settle starts another idle wait.
        if (tab.focusPending.size > 0 || tab.screencasts.size > 0 || waitingHolds(tab)) {
          return;
        }
        // The agent pauses to think between steps; its tab stays focused until the turn ends.
        if (
          tab.agentUsed &&
          connections.get(tab.key.environmentId)?.agentTurns.has(tab.key.threadId)
        )
          return;
        tab.agentUsed = false;
        if (tabs.get(keyOf(tab.key)) === tab) setFocusEmulation(tab, false);
      }),
    );
  };

  /**
   * Electron composites no offscreen guest, so its screenshot or screencast waits for a frame
   * that never comes. The client paints the guest behind the app while one is pending; the
   * capture then finishes on its own, and the guest goes back offscreen once none is.
   */
  const syncPainting = (tab: AttachedTab) => {
    const active =
      tabs.get(keyOf(tab.key)) === tab &&
      (tab.screencasts.size > 0 ||
        tab.capturing.size > 0 ||
        tab.waitingScreenshots.some((waiting) => waiting.live()));
    if (tab.painting === active) return;
    tab.painting = active;
    runFork(PubSub.publish(painting, { key: tab.key, active }));
  };

  /** A command may wait on the page's next frame, so the guest stays focused until it settles. */
  const holdFocus = <A>(tab: AttachedTab, owner: string | undefined, work: () => Promise<A>) => {
    const pending = {};
    tab.focusPending.set(pending, owner);
    tab.focusUses += 1;
    setFocusEmulation(tab, true);
    releaseFocusWhenIdle(tab);
    return work().finally(() => {
      if (!tab.focusPending.delete(pending)) return;
      tab.focusUses += 1;
      releaseFocusWhenIdle(tab);
    });
  };

  /**
   * A scaled guest rasters at its on-screen size until the client draws it at full detail,
   * and a screenshot taken before that copies the blurred frame. A client that cannot draw
   * (a hidden window, say) only delays the capture.
   */
  const whenDrawn = (tab: AttachedTab) =>
    new Promise<void>((resolve) => {
      const id = keyOf(tab.key);
      const waiters = drawWaiters.get(id) ?? new Set();
      drawWaiters.set(id, waiters);
      const done = () => {
        waiters.delete(done);
        if (waiters.size === 0 && drawWaiters.get(id) === waiters) drawWaiters.delete(id);
        resolve();
      };
      waiters.add(done);
      runFork(Effect.sleep(CAPTURE_DRAW_WAIT).pipe(Effect.andThen(Effect.sync(done))));
    });

  /** Chromium answers a capture, and frees its wake lock, only once the guest paints a frame. */
  const paintUntilAnswered = <A>(tab: AttachedTab, send: () => Promise<A>) => {
    const sent = {};
    tab.capturing.add(sent);
    syncPainting(tab);
    // Sent at once when already drawn, so it keeps its place among the commands after it.
    return (drawnTabs.has(keyOf(tab.key)) ? send() : whenDrawn(tab).then(send)).finally(() => {
      tab.capturing.delete(sent);
      syncPainting(tab);
    });
  };

  /**
   * Chromium can leave a command unanswered, so the screenshot guard's release points
   * also end every focus hold: a released relay has no one waiting, and a new document
   * answers nothing pending from the old one. A released relay's screencast has no viewer.
   */
  const dropFocusHolds = (tab: AttachedTab) => {
    tab.focusPending.clear();
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  const dropRelay = (tab: AttachedTab) => {
    tab.relay = null;
    tab.screencasts.clear();
    tab.agentUsed = false;
    dropFocusHolds(tab);
  };

  /** An owner that leaves without stopping would otherwise keep the screencast running unseen. */
  const leaveScreencast = (tab: AttachedTab, owner: string | undefined) => {
    if (!tab.screencasts.delete(owner) || tab.screencasts.size > 0) return;
    void tab.debuggee.debugger.sendCommand("Page.stopScreencast").catch(() => {});
  };

  /** A detached session, such as a closed viewer, waits on nothing it sent. */
  const dropSessionHolds = (tab: AttachedTab, owner: string) => {
    leaveScreencast(tab, owner);
    for (const [pending, holder] of tab.focusPending) {
      if (holder === owner) tab.focusPending.delete(pending);
    }
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  /**
   * A command the server stopped waiting on, such as a timed-out screenshot or evaluation,
   * may never settle; the turn's end ends every focus hold. The agent also sends on its own extra
   * session, so this cannot spare other sessions; a viewer's screencast still holds.
   */
  const endAgentTurn = (connection: TargetConnection, threadId: string) => {
    connection.agentTurns.delete(threadId);
    for (const tab of tabs.values()) {
      if (tab.key.environmentId !== connection.environmentId || tab.key.threadId !== threadId)
        continue;
      tab.agentUsed = false;
      // Still sent in turn, so the queue keeps moving, but no longer kept focused.
      for (const waiting of tab.waitingScreenshots) waiting.held = false;
      dropFocusHolds(tab);
    }
  };

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee, cookiesCleared } = tab.debuggee;
    const target = connections.get(tab.key.environmentId);
    const connection = target?.token ?? null;
    const closeConnection = target?.close;
    if (tab.relaySessions?.connection !== connection) {
      tab.relaySessions = { connection, state: createCdpRelaySessionState() };
    }
    const sessionState = tab.relaySessions.state;
    const send = (method: string, params: Record<string, unknown>, sessionId?: string) => {
      const current = () => {
        if (privateContents.has(webContents) || tab.relay !== relay)
          throw new Error("Private credential entry");
      };
      if (
        tab.debuggee.setViewport &&
        sessionId === undefined &&
        (method === "Emulation.setDeviceMetricsOverride" ||
          method === "Emulation.clearDeviceMetricsOverride")
      ) {
        current();
        const setting = decodeViewportSetting(
          method === "Emulation.clearDeviceMetricsOverride"
            ? { _tag: "fill" }
            : { _tag: "freeform", width: params["width"], height: params["height"] },
        );
        return tab.debuggee.setViewport(setting).then(() => {
          current();
          return {};
        });
      }
      return sendPageCommand(webContents, debuggee, method, params, sessionId, current).then(
        async (result) => {
          if (method === "Network.clearBrowserCookies") await cookiesCleared?.();
          current();
          return result;
        },
      );
    };
    const detachedOwners = new Set<string>();
    /** Viewers and recordings stream; the agent's own sessions never do. */
    const streamingOwners = new Set<string>();
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId, owner) => {
          // A child session's screencast is not the page's, such as a late one on a detached session.
          const stream =
            sessionId === undefined && method === "Page.startScreencast"
              ? (tab.screencasts.get(owner) ?? { started: false, pending: 0 })
              : undefined;
          if (stream) {
            stream.pending += 1;
            tab.screencasts.set(owner, stream);
            if (owner !== undefined) streamingOwners.add(owner);
            syncPainting(tab);
          } else if (sessionId === undefined && method === "Page.stopScreencast") {
            tab.screencasts.delete(owner);
            syncPainting(tab);
            if (tab.screencasts.size > 0) return Promise.resolve({});
          }
          // A person's input through a viewer, or Playwright's own housekeeping, is not the agent's.
          if (AGENT_INPUT_METHOD.test(method)) {
            if (owner === undefined || !streamingOwners.has(owner)) {
              tab.agentUsed = true;
              tab.agentLedAt = performance.now();
            } else if (method.startsWith("Input.") && !POINTER_TRAVEL.has(params["type"])) {
              tab.agentLedAt = Number.NEGATIVE_INFINITY;
            }
          }
          // Waits for focus emulation; insertText and other non-CDP input would not queue behind it.
          const forward = (current?: () => boolean) => {
            const change = tab.focusChange;
            const capture = async () => {
              if (tab.relay !== relay || (current !== undefined && !current()))
                throw new Error("The page this screenshot was for has moved on.");
              const revision =
                method === "Page.captureScreenshot" ? tab.debuggee.captureRevision?.() : undefined;
              const release =
                method === "Page.captureScreenshot"
                  ? tab.debuggee.acquireCaptureHold?.()
                  : undefined;
              try {
                const result = await send(method, params, sessionId);
                if (
                  method === "Page.captureScreenshot" &&
                  (tab.relay !== relay ||
                    (current !== undefined && !current()) ||
                    revision !== tab.debuggee.captureRevision?.())
                )
                  throw new Error("The preview changed while its screenshot was being captured.");
                return result;
              } finally {
                release?.();
              }
            };
            const run = () =>
              current === undefined || tab.relay !== relay || !current()
                ? capture()
                : paintUntilAnswered(tab, capture);
            return change === null ? run() : change.then(run);
          };
          return method === "Page.captureScreenshot"
            ? takeScreenshot(
                tab,
                relay,
                () => owner === undefined || !detachedOwners.has(owner),
                (current, held) =>
                  held ? holdFocus(tab, owner, () => forward(current)) : forward(current),
              )
            : method === "Page.startScreencast"
              ? holdFocus(tab, owner, forward).then(
                  (result) => {
                    if (stream) {
                      stream.pending -= 1;
                      stream.started = true;
                      // A detach's stop can overtake a start still waiting on focus; nobody owns it now.
                      if (tab.screencasts.get(owner) !== stream && tab.screencasts.size === 0) {
                        void debuggee.sendCommand("Page.stopScreencast").catch(() => {});
                      }
                    }
                    return result;
                  },
                  (cause: unknown) => {
                    if (stream) stream.pending -= 1;
                    // A viewer can outlive a refused start; its running or pending stream still holds it.
                    if (
                      stream &&
                      !stream.started &&
                      stream.pending === 0 &&
                      tab.relay === relay &&
                      tab.screencasts.get(owner) === stream
                    ) {
                      leaveScreencast(tab, owner);
                    }
                    releaseFocusWhenIdle(tab);
                    syncPainting(tab);
                    throw cause;
                  },
                )
              : holdFocus(tab, owner, forward);
        },
        sessionDetached: (owner) => {
          detachedOwners.add(owner);
          dropSessionHolds(tab, owner);
        },
        receivesScreencast: (owner) => tab.screencasts.has(owner),
        ackScreencastFrame: (frameId) =>
          void debuggee
            .sendCommand("Page.screencastFrameAck", { sessionId: frameId })
            .catch(() => {}),
        targetId: async () => {
          if (privateContents.has(webContents) || tab.relay !== relay)
            throw new Error("Private credential entry");
          const result: { targetInfo: { targetId: string } } =
            await debuggee.sendCommand("Target.getTargetInfo");
          if (privateContents.has(webContents) || tab.relay !== relay)
            throw new Error("Private credential entry");
          return result.targetInfo.targetId;
        },
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        userAgent: () => webContents.getUserAgent(),
        setDownloadDirectory: (directory) => {
          if (!privateContents.has(webContents) && tab.relay === relay)
            tab.downloadDirectory = directory;
        },
      },
      (message) => {
        if (
          !privateContents.has(webContents) &&
          tab.relay === relay &&
          connections.get(tab.key.environmentId)?.token === connection &&
          tabs.get(keyOf(tab.key)) === tab
        ) {
          return runPromise(
            PubSub.publish(outbox, {
              connection,
              event: { type: "cdp", ...wireKey(tab.key), message },
            }),
          ).then(
            () => {},
            () => {
              closeConnection?.();
              throw unavailable();
            },
          );
        }
      },
      // Announcing the tab again would reconnect Playwright, and the page could
      // replay the same oversized event, so the tab stays detached.
      () => {
        if (tab.relay !== relay || tabs.get(keyOf(tab.key)) !== tab) return;
        // Disabling auto-attach detaches child sessions and releases their debugger pauses.
        void debuggee
          .sendCommand("Target.setAutoAttach", {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          })
          .catch(() => {});
        if (tab.screencasts.size > 0) {
          void debuggee.sendCommand("Page.stopScreencast").catch(() => {});
        }
        setFocusEmulation(tab, false);
        detach(tab.key);
      },
      sessionState,
    );
    tab.relay = relay;
    return relay;
  };

  // CDP supplies the path before this runs; otherwise Electron opens a Save dialog.
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    const tab = [...tabs.values()].find(
      (candidate) =>
        candidate.debuggee.webContents === source &&
        !privateContents.has(source) &&
        candidate.downloadDirectory,
    );
    if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
    item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
    tab.pendingDownloadGuid = null;
    return true;
  };

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    invalidate(tab);
    tabs.delete(id);
    const announced = tab.stopWaiting === null;
    tab.stopWaiting?.();
    tab.relay = null;
    tab.debuggee.debugger.off("message", tab.onMessage);
    tab.debuggee.webContents.off("did-navigate", tab.onNewDocument);
    syncPainting(tab);
    if (announced)
      emit(
        {
          type: "detached",
          ...wireKey(key),
          ...(tab.attachment ? { privateEntry: tab.attachment } : {}),
        },
        key.environmentId,
      );
  };

  const restorationFor = (tab: AttachedTab) => {
    if (tab.debuggee.webContents.isDestroyed() || privateContents.has(tab.debuggee.webContents)) {
      return {};
    }
    const restoration = tab.debuggee.getRestoration?.();
    return restoration === undefined ? {} : { restoration };
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const channelEpoch = connections.get(key.environmentId)?.epoch;
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
      relaySessions: null,
      attachment: channelEpoch ? { channelEpoch, attachmentId: NodeCrypto.randomUUID() } : null,
      pending: null,
      lease: null,
      releasedLease: null,
      cancelled: new Set(),
      screenshotTurn: null,
      waitingScreenshots: [],
      downloadDirectory: null,
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      agentLedAt: Number.NEGATIVE_INFINITY,
      focusEmulated: false,
      focusChange: null,
      focusUses: 0,
      focusPending: new Map(),
      capturing: new Set(),
      painting: false,
      agentUsed: false,
      focusReleasing: false,
      screencasts: new Map(),
      onMessage: (_event, method, params, sessionId) => {
        if (privateContents.has(debuggee.webContents)) return;
        if (method === "Page.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
      // A screenshot pending when the page loads a new document, a reload included, can
      // stay unanswered. A crashed page lands here once it reloads, well after its renderer died.
      onNewDocument: () => {
        // Before the next screenshot starts, so its own holds survive.
        tab.capturing.clear();
        dropFocusHolds(tab);
        if (tab.screenshotTurn !== null) nextScreenshot(tab);
      },
      stopWaiting: null,
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    debuggee.webContents.on("did-navigate", tab.onNewDocument);
    const announce = () => {
      const connection = connections.get(key.environmentId);
      if (connection) runFork(announceTab(tab, connection));
    };
    if (!debuggee.webContents.isLoadingMainFrame()) {
      announce();
      return;
    }
    // Electron does not pause a guest for the debugger, so Playwright connecting during its first
    // commit builds its utility world in the discarded document and every wait on it hangs.
    const { webContents } = debuggee;
    // ERR_ABORTED is a newer navigation replacing this one, whose commit is still to come.
    const onFailLoad = (
      _event: Electron.Event,
      code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && code !== ERR_ABORTED) ready();
    };
    const ready = () => {
      if (tab.stopWaiting === null) return;
      // The manager's cleanup for a destroyed guest can still be queued behind another tab's attach.
      if (webContents.isDestroyed()) return detach(key);
      tab.stopWaiting();
      announce();
    };
    const timeout = runFork(
      Effect.sleep(FIRST_PAGE_TIMEOUT).pipe(Effect.andThen(Effect.sync(ready))),
    );
    tab.stopWaiting = () => {
      tab.stopWaiting = null;
      webContents.off("dom-ready", ready);
      webContents.off("did-stop-loading", ready);
      webContents.off("did-fail-load", onFailLoad);
      runFork(Fiber.interrupt(timeout));
    };
    webContents.on("dom-ready", ready);
    webContents.on("did-stop-loading", ready);
    webContents.on("did-fail-load", onFailLoad);
  };

  const setShown = (key: DesktopBrowserTabKey, shown: boolean | undefined) => {
    const id = keyOf(key);
    if (shown === undefined) {
      shownTabs.delete(id);
      return;
    }
    if (shownTabs.get(id) === shown) return;
    shownTabs.set(id, shown);
    if (tabs.get(id)?.stopWaiting === null)
      emit({ type: "shown", ...wireKey(key), shown }, key.environmentId);
  };

  const setCaptureDrawn = (key: DesktopBrowserTabKey, drawn: boolean | undefined) => {
    const id = keyOf(key);
    if (!drawn) {
      drawnTabs.delete(id);
      return;
    }
    drawnTabs.add(id);
    for (const done of drawWaiters.get(id) ?? []) done();
    drawWaiters.delete(id);
  };

  const loadFailed: DesktopBrowserHost["Service"]["loadFailed"] = (key, failure) => {
    if (tabs.has(keyOf(key)))
      emit({ type: "loadFailed", ...wireKey(key), ...failure }, key.environmentId);
  };

  const dispatchCommandLine = (line: string, connection: TargetConnection) =>
    Effect.sync(() => {
      if (connections.get(connection.environmentId) !== connection) return;
      // Reservation metadata must survive the private CDP early return.
      const control = decodePrivateResponse(line);
      if (Option.isSome(control)) {
        handlePrivateResponse(control.value, connection.environmentId);
        return;
      }
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      if (command.value.type === "turn") {
        if (command.value.active) connection.agentTurns.add(command.value.threadId);
        else endAgentTurn(connection, command.value.threadId);
        return;
      }
      const tab = tabs.get(keyOf({ ...command.value, environmentId: connection.environmentId }));
      if (!tab) return;
      if (command.value.type === "reattach") {
        runFork(announceTab(tab, connection));
        return;
      }
      if (privateContents.has(tab.debuggee.webContents)) {
        if (command.value.type === "cdp") {
          const request = decodePrivateCdpRequest(command.value.message);
          if (Option.isSome(request))
            emit(
              {
                type: "cdp",
                ...wireKey(tab.key),
                message: encodePrivateCdpError({
                  id: request.value.id,
                  error: { code: -32000, message: "This tab is private during credential entry." },
                  ...(request.value.sessionId === undefined
                    ? {}
                    : { sessionId: request.value.sessionId }),
                }),
              },
              connection.environmentId,
            );
        }
        return;
      }
      if (command.value.type === "pointer") {
        const { phase, x, y } = command.value;
        runFork(PubSub.publish(pointers, { key: tab.key, phase, x, y }));
        return;
      }
      if (command.value.type === "release") {
        dropRelay(tab);
        tab.relaySessions = null;
        return;
      }
      if (command.value.type !== "cdp") return;
      if (AGENT_INPUT_COMMAND.test(command.value.message)) tab.agentInputAt = performance.now();
      const settled = relayFor(tab).receive(command.value.message);
      return settled ? { settled } : undefined;
    });

  // The ordinary FD reader starts commands independently; only explicit observers await completion.
  const handleCommandLine = Effect.fn("DesktopBrowserHost.handleCommandLine")(
    (line: string, connection: TargetConnection) =>
      Effect.gen(function* () {
        const completion = yield* dispatchCommandLine(line, connection);
        if (completion) void completion.settled.catch(connection.close);
      }),
  );

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_INPUT_WINDOW_MS;
  };

  const agentLedPage = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentLedAt <= AGENT_INPUT_WINDOW_MS;
  };

  const announceTab = Effect.fn("DesktopBrowserHost.announceTab")(function* (
    tab: AttachedTab,
    connection: TargetConnection,
  ) {
    if (tab.stopWaiting !== null) return;
    if (
      connections.get(connection.environmentId) !== connection ||
      tabs.get(keyOf(tab.key)) !== tab
    )
      return;
    if (connection.proxyUrl)
      yield* Effect.promise(() =>
        configureTargetSession(connection.environmentId, tab.debuggee.webContents.session),
      );
    if (
      connections.get(connection.environmentId) !== connection ||
      tabs.get(keyOf(tab.key)) !== tab
    )
      return;
    invalidate(tab);
    tab.attachment = { channelEpoch: connection.epoch, attachmentId: NodeCrypto.randomUUID() };
    tab.cancelled.clear();
    const shown = shownTabs.get(keyOf(tab.key));
    yield* PubSub.publish(outbox, {
      connection: connection.token,
      event: {
        type: "attached",
        ...wireKey(tab.key),
        ...restorationFor(tab),
        privateEntry: tab.attachment,
      },
    });
    if (shown !== undefined)
      yield* PubSub.publish(outbox, {
        connection: connection.token,
        event: { type: "shown", ...wireKey(tab.key), shown },
      });
  });
  const announceAll = (connection: TargetConnection) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...tabs.values()].filter((tab) => tab.key.environmentId === connection.environmentId),
        (tab) => announceTab(tab, connection),
        { discard: true },
      ),
    );

  const createConnection = (
    targetEnvironmentId?: string,
    proxyUrl?: string,
  ): DesktopBrowserConnection => {
    const token = Symbol();
    const epoch = NodeCrypto.randomUUID();
    const stopped = Promise.withResolvers<void>();
    let closed = false;
    let subscribed = false;
    let closing: Promise<void> | undefined;
    const close = (announce = true) => {
      if (closed) return closing ?? Promise.resolve();
      closed = true;
      stopped.resolve();
      const drains: Promise<void>[] = [];
      for (const session of connection.networkSessions) {
        const current = networkSessions.get(session);
        if (current?.connection !== connection) continue;
        current.allowed = false;
        current.ready = current.ready
          .catch(() => undefined)
          .then(() => session.closeAllConnections());
        drains.push(current.ready);
      }
      connection.networkSessions.clear();
      if (connections.get(targetEnvironmentId) === connection) {
        connections.delete(targetEnvironmentId);
        if (announce) announceEnvironments();
        for (const tab of tabs.values()) {
          if (tab.key.environmentId !== targetEnvironmentId) continue;
          invalidate(tab);
          tab.attachment = null;
        }
      }
      closing = Promise.all(drains).then(() => undefined);
      return closing;
    };
    const connection: TargetConnection = {
      environmentId: targetEnvironmentId,
      proxyUrl,
      token,
      epoch,
      close,
      networkSessions: new Set(),
      agentTurns: new Set(),
    };
    return {
      closed: Effect.promise(() => close()),
      handleCommandLine: (line) =>
        Effect.suspend(() =>
          !closed && connections.get(targetEnvironmentId) === connection
            ? handleCommandLine(line, connection)
            : Effect.void,
        ),
      dispatchCommandLine: (line) =>
        Effect.suspend(() => {
          if (closed || connections.get(targetEnvironmentId) !== connection)
            return Effect.undefined;
          return dispatchCommandLine(line, connection).pipe(
            Effect.map((completion) => {
              if (completion) void completion.settled.catch(close);
              return completion;
            }),
          );
        }),
      events: Stream.unwrap(
        Effect.gen(function* () {
          if (closed || subscribed) return Stream.empty;
          subscribed = true;
          const previous = connections.get(targetEnvironmentId);
          const previousClosed = previous?.close(false);
          connections.set(targetEnvironmentId, connection);
          yield* Effect.addFinalizer(() => Effect.promise(() => close()));
          if (previousClosed) yield* Effect.promise(() => previousClosed);
          const subscription = yield* PubSub.subscribe(outbox);
          yield* announceAll(connection);
          announceEnvironments();
          return Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (item) =>
                !closed &&
                connections.get(targetEnvironmentId) === connection &&
                item.connection === token,
            ),
            Stream.map((item) => lineEncoder.encode(`${encodeEvent(item.event)}\n`)),
            Stream.interruptWhen(Effect.promise(() => stopped.promise)),
          );
        }),
      ),
    };
  };

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    painting: Stream.fromPubSub(painting),
    // Compatibility for fixtures/legacy callers; primary backend must capture createConnection().
    events: Stream.unwrap(Effect.sync(() => createConnection().events)),
    createConnection,
    hostedEnvironmentIds,
    configureTargetSession,
    hostedEnvironmentsChanged: Stream.fromPubSub(hostedEnvironmentsChanged),
    handleCommandLine: Effect.fn("DesktopBrowserHost.handleCommandLine")((line) =>
      Effect.suspend(() => {
        const connection = connections.get(undefined);
        return connection ? handleCommandLine(line, connection) : Effect.void;
      }),
    ),
    attach,
    detach,
    setPrivateEntry,
    isPrivateEntry: (source) => privateContents.has(source),
    privateEntryChanges: Stream.fromPubSub(privateEntryChanges),
    canRequestPrivateEntry: (source) => {
      const tab = attachedFor(source);
      return !!tab && isCurrentAttachment(tab);
    },
    acquirePrivateEntry,
    loadFailed,
    setShown,
    setCaptureDrawn,
    placeDownload,
    humanStartedDownload,
    agentLedPage,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
