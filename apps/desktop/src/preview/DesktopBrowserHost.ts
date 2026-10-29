// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/** The manager owns the single debugger attachment; the relay shares it. */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  DesktopBrowserPrivateEntryResponse,
  type DesktopBrowserPrivateEntryAttachment,
  type DesktopBrowserPrivateEntryRequest,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodePrivateResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(DesktopBrowserPrivateEntryResponse),
);
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
const decodePrivateCdpId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const encodePrivateCdpError = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
    }),
  ),
);
/** CDP commands through which an agent clicks, types, or navigates the page. */
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
/** The same commands as above, by method, for the relay's sends. */
const AGENT_INPUT_METHOD = /^(?:Input\.|Page\.navigate$|Runtime\.(?:evaluate|callFunctionOn)$)/;
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;
const FOCUS_IDLE = "5 seconds";

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

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
  attachment: DesktopBrowserPrivateEntryAttachment | null;
  lease: LeaseState | null;
  releasedLease: LeaseState | null;
  pending: PendingControl | null;
  readonly cancelled: Set<string>;
  /** Where the server wants this tab's downloads; null keeps Electron's own handling. */
  screenshotTurn: object | null;
  /** Each holds focus and painting while `held` and whoever queued it still waits on it. */
  readonly waitingScreenshots: Array<{
    readonly start: () => void;
    readonly live: () => boolean;
    held: boolean;
  }>;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  focusEmulated: boolean;
  focusChange: Promise<void> | null;
  focusUses: number;
  /** Each pending command, by the extra session waiting on it; the main connection's have none. */
  readonly focusPending: Map<
    object,
    { readonly owner: string | undefined; readonly paints: boolean }
  >;
  /** Whether the client keeps the guest painting, as published on `painting`. */
  painting: boolean;
  /**
   * Driven by the agent since its thread's last turn ended or the guest last throttled. A
   * turn's start can reach us after its first command, so this holds focus once it does.
   */
  agentUsed: boolean;
  focusReleasing: boolean;
  /** The sessions streaming the guest; one stopping leaves the others' screencasts running. */
  readonly screencasts: Set<string | undefined>;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
  readonly onNewDocument: () => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    readonly events: Stream.Stream<Uint8Array>;
    readonly createConnection: () => DesktopBrowserConnection;
    /** One line from the backend's browser control fd. */
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    readonly detach: (key: DesktopBrowserTabKey) => void;
    /** Native credential entry blocks every relay operation, including observations. */
    readonly setPrivateEntry: (source: Electron.WebContents, active: boolean) => void;
    readonly isPrivateEntry: (source: Electron.WebContents) => boolean;
    readonly canRequestPrivateEntry: (source: Electron.WebContents) => boolean;
    readonly acquirePrivateEntry: (
      source: Electron.WebContents,
    ) => Promise<NativePrivateEntryLease>;
    /**
     * Whether a server tab's download came from the person at this desktop:
     * the server sent the page no input just before it started.
     */
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
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
  /** Threads whose agent turn runs, by the server's account. */
  const agentTurns = new Set<string>();
  const privateContents = new WeakSet<Electron.WebContents>();
  let activeConnection: symbol | null = null;
  let closeActiveConnection: (() => void) | null = null;
  let channelEpoch: string | null = null;
  const setPrivateEntry = (source: Electron.WebContents, active: boolean) => {
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
  const emit = (event: DesktopBrowserEventType) =>
    runFork(PubSub.publish(outbox, { connection: activeConnection, event }));

  const unavailable = () => new Error("Native private entry is unavailable");
  const attachedFor = (source: Electron.WebContents) =>
    [...tabs.values()].find((tab) => tab.debuggee.webContents === source);
  const isCurrentAttachment = (tab: AttachedTab) =>
    channelEpoch !== null &&
    activeConnection !== null &&
    tab.attachment?.channelEpoch === channelEpoch &&
    tabs.get(keyOf(tab.key)) === tab &&
    !tab.debuggee.webContents.isDestroyed();
  const cancel = (
    tab: AttachedTab,
    request: Pick<DesktopBrowserPrivateEntryRequest, "channelEpoch" | "attachmentId" | "requestId">,
  ) => {
    tab.cancelled.add(request.requestId);
    if (tab.cancelled.size > 8) tab.cancelled.delete(tab.cancelled.values().next().value!);
    if (isCurrentAttachment(tab))
      emit({
        type: "private-entry-cancel",
        ...tab.key,
        channelEpoch: request.channelEpoch,
        attachmentId: request.attachmentId,
        requestId: request.requestId,
      });
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
      emit(message);
    });
  const leaseHandle = (tab: AttachedTab, lease: LeaseState): NativePrivateEntryLease => {
    const connection = activeConnection;
    const attachment = tab.attachment;
    return {
      current: () => isCurrentAttachment(tab) && tab.lease === lease && lease.active,
      async release() {
        if (
          !isCurrentAttachment(tab) ||
          activeConnection !== connection ||
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
          ...tab.key,
          ...attachment,
          requestId: NodeCrypto.randomUUID(),
          leaseId: lease.leaseId,
          generation: lease.generation,
        });
        const resume: NativePrivateEntryResume = {
          current: () =>
            activeConnection === connection &&
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
      ...tab.key,
      ...tab.attachment,
      requestId: NodeCrypto.randomUUID(),
    });
    if (!result?.current()) throw unavailable();
    return result;
  };
  const handlePrivateResponse = (response: typeof DesktopBrowserPrivateEntryResponse.Type) => {
    const tab = tabs.get(keyOf(response));
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
    /** Sends only while `current` holds; holds focus and painting only while `held`. */
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
        if (tab.agentUsed && agentTurns.has(tab.key.threadId)) return;
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
        waitingHolds(tab) ||
        [...tab.focusPending.values()].some((hold) => hold.paints));
    if (tab.painting === active) return;
    tab.painting = active;
    runFork(PubSub.publish(painting, { key: tab.key, active }));
  };

  /** A command may wait on the page's next frame, so the guest stays focused until it settles. */
  const holdFocus = <A>(
    tab: AttachedTab,
    method: string,
    owner: string | undefined,
    work: () => Promise<A>,
  ) => {
    const pending = {};
    tab.focusPending.set(pending, { owner, paints: method === "Page.captureScreenshot" });
    tab.focusUses += 1;
    setFocusEmulation(tab, true);
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
    return work().finally(() => {
      if (!tab.focusPending.delete(pending)) return;
      tab.focusUses += 1;
      releaseFocusWhenIdle(tab);
      syncPainting(tab);
    });
  };

  /**
   * Chromium can leave a command unanswered, so the screenshot guard's release points
   * also end every hold: a released relay has no one waiting, and a new document answers
   * nothing pending from the old one. A released relay's screencast has no viewer to stop it.
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

  /** A detached session, such as a closed viewer, waits on nothing it sent. */
  const dropSessionHolds = (tab: AttachedTab, owner: string) => {
    tab.screencasts.delete(owner);
    for (const [pending, hold] of tab.focusPending) {
      if (hold.owner === owner) tab.focusPending.delete(pending);
    }
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  /**
   * A command the server stopped waiting on, such as a timed-out screenshot or evaluation,
   * may never settle; the turn's end ends every hold. The agent also sends on its own extra
   * session, so this cannot spare other sessions; a viewer's screencast still holds.
   */
  const endAgentTurn = (threadId: string) => {
    agentTurns.delete(threadId);
    for (const tab of tabs.values()) {
      if (tab.key.threadId !== threadId) continue;
      tab.agentUsed = false;
      // Still sent in turn, so the queue keeps moving, but no longer kept painting.
      for (const waiting of tab.waitingScreenshots) waiting.held = false;
      dropFocusHolds(tab);
    }
  };

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const connection = activeConnection;
    const closeConnection = closeActiveConnection;
    const send = (method: string, params: Record<string, unknown>, sessionId?: string) => {
      if (privateContents.has(webContents) || tab.relay !== relay)
        return Promise.reject(new Error("Private credential entry"));
      return sessionId === undefined
        ? sendPageCommand(webContents, debuggee, method, params)
        : debuggee.sendCommand(method, params, sessionId);
    };
    const detachedOwners = new Set<string>();
    /** Viewers and recordings stream; the agent's own sessions never do. */
    const streamingOwners = new Set<string>();
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId, owner) => {
          // A child session's screencast is not the page's, such as a late one on a detached session.
          if (sessionId === undefined && method === "Page.startScreencast") {
            tab.screencasts.add(owner);
            if (owner !== undefined) streamingOwners.add(owner);
          } else if (sessionId === undefined && method === "Page.stopScreencast") {
            tab.screencasts.delete(owner);
          }
          // A person's input through a viewer, or Playwright's own housekeeping, is not the agent's.
          if (
            AGENT_INPUT_METHOD.test(method) &&
            (owner === undefined || !streamingOwners.has(owner))
          ) {
            tab.agentUsed = true;
          }
          // Waits for focus emulation; insertText and other non-CDP input would not queue behind it.
          const forward = (current?: () => boolean) => {
            const change = tab.focusChange;
            const run = () =>
              current === undefined || current()
                ? send(method, params, sessionId)
                : Promise.reject(new Error("The page this screenshot was for has moved on."));
            return change === null ? run() : change.then(run);
          };
          return method === "Page.captureScreenshot"
            ? takeScreenshot(
                tab,
                relay,
                () => owner === undefined || !detachedOwners.has(owner),
                (current, held) =>
                  held ? holdFocus(tab, method, owner, () => forward(current)) : forward(current),
              )
            : method === "Page.startScreencast"
              ? holdFocus(tab, method, owner, forward).catch((cause: unknown) => {
                  // A viewer can outlive a refused stream; nothing is streaming for it.
                  if (sessionId === undefined && tab.relay === relay) tab.screencasts.delete(owner);
                  releaseFocusWhenIdle(tab);
                  syncPainting(tab);
                  throw cause;
                })
              : holdFocus(tab, method, owner, forward);
        },
        sessionDetached: (owner) => {
          detachedOwners.add(owner);
          dropSessionHolds(tab, owner);
        },
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
          activeConnection === connection &&
          tabs.get(keyOf(tab.key)) === tab
        ) {
          return runPromise(
            PubSub.publish(outbox, {
              connection,
              event: { type: "cdp", ...tab.key, message },
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
    tab.relay = null;
    tab.debuggee.debugger.off("message", tab.onMessage);
    tab.debuggee.webContents.off("did-navigate", tab.onNewDocument);
    syncPainting(tab);
    emit({ type: "detached", ...key, ...(tab.attachment ? { privateEntry: tab.attachment } : {}) });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
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
      focusEmulated: false,
      focusChange: null,
      focusUses: 0,
      focusPending: new Map(),
      painting: false,
      agentUsed: false,
      focusReleasing: false,
      screencasts: new Set(),
      onMessage: (_event, method, params, sessionId) => {
        if (privateContents.has(debuggee.webContents)) return;
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
      // A screenshot pending when the page loads a new document, a reload included, can
      // stay unanswered. A crashed page lands here once it reloads, well after its renderer died.
      onNewDocument: () => {
        // Before the next screenshot starts, so its own hold survives.
        dropFocusHolds(tab);
        if (tab.screenshotTurn !== null) nextScreenshot(tab);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    debuggee.webContents.on("did-navigate", tab.onNewDocument);
    emit({ type: "attached", ...key, ...(tab.attachment ? { privateEntry: tab.attachment } : {}) });
  };

  const dispatchCommandLine = (line: string) =>
    Effect.sync(() => {
      // Reservation metadata must survive the private CDP early return.
      const control = decodePrivateResponse(line);
      if (Option.isSome(control)) {
        handlePrivateResponse(control.value);
        return;
      }
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      if (command.value.type === "turn") {
        if (command.value.active) agentTurns.add(command.value.threadId);
        else endAgentTurn(command.value.threadId);
        return;
      }
      const tab = tabs.get(keyOf(command.value));
      if (!tab) return;
      if (privateContents.has(tab.debuggee.webContents)) {
        if (command.value.type === "cdp") {
          const request = decodePrivateCdpId(command.value.message);
          if (Option.isSome(request))
            emit({
              type: "cdp",
              ...tab.key,
              message: encodePrivateCdpError({
                id: request.value.id,
                error: { code: -32000, message: "This tab is private during credential entry." },
              }),
            });
        }
        return;
      }
      if (command.value.type === "pointer") {
        const { threadId, tabId, phase, x, y } = command.value;
        runFork(PubSub.publish(pointers, { key: { threadId, tabId }, phase, x, y }));
        return;
      }
      if (command.value.type === "release") {
        dropRelay(tab);
        return;
      }
      if (command.value.type !== "cdp") return;
      if (AGENT_INPUT_COMMAND.test(command.value.message)) tab.agentInputAt = performance.now();
      const settled = relayFor(tab).receive(command.value.message);
      return settled ? { settled } : undefined;
    });

  // The ordinary FD reader starts commands independently; only explicit observers await completion.
  const handleCommandLine = Effect.fn("DesktopBrowserHost.handleCommandLine")((line: string) =>
    Effect.gen(function* () {
      const closeConnection = closeActiveConnection;
      const completion = yield* dispatchCommandLine(line);
      if (completion) void completion.settled.catch(() => closeConnection?.());
    }),
  );

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
  };

  const announceAll = Effect.suspend(() => {
    // A new backend: the old one's turns ended without telling us.
    agentTurns.clear();
    return Effect.forEach(
      [...tabs.values()],
      (tab) => {
        invalidate(tab);
        tab.attachment = channelEpoch
          ? { channelEpoch, attachmentId: NodeCrypto.randomUUID() }
          : null;
        tab.cancelled.clear();
        return PubSub.publish(outbox, {
          connection: activeConnection,
          event: {
            type: "attached",
            ...tab.key,
            ...(tab.attachment ? { privateEntry: tab.attachment } : {}),
          },
        });
      },
      { discard: true },
    );
  });

  const createConnection = (): DesktopBrowserConnection => {
    const token = Symbol();
    const epoch = NodeCrypto.randomUUID();
    const stopped = Promise.withResolvers<void>();
    let closed = false;
    let subscribed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stopped.resolve();
      if (activeConnection !== token) return;
      activeConnection = null;
      channelEpoch = null;
      closeActiveConnection = null;
      for (const tab of tabs.values()) {
        invalidate(tab);
        tab.attachment = null;
      }
    };
    return {
      closed: Effect.sync(close),
      handleCommandLine: (line) =>
        Effect.suspend(() =>
          !closed && activeConnection === token ? handleCommandLine(line) : Effect.void,
        ),
      dispatchCommandLine: (line) =>
        Effect.suspend(() => {
          // @effect-diagnostics-next-line effectSucceedWithVoid:off -- Dispatch uses undefined to signal that no completion acknowledgement exists.
          if (closed || activeConnection !== token) return Effect.succeed(undefined);
          return dispatchCommandLine(line).pipe(
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
          closeActiveConnection?.();
          activeConnection = token;
          channelEpoch = epoch;
          closeActiveConnection = close;
          yield* Effect.addFinalizer(() => Effect.sync(close));
          const subscription = yield* PubSub.subscribe(outbox);
          yield* announceAll;
          return Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (item) => !closed && activeConnection === token && item.connection === token,
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
    handleCommandLine,
    attach,
    detach,
    setPrivateEntry,
    isPrivateEntry: (source) => privateContents.has(source),
    canRequestPrivateEntry: (source) => {
      const tab = attachedFor(source);
      return !!tab && isCurrentAttachment(tab);
    },
    acquirePrivateEntry,
    placeDownload,
    humanStartedDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
