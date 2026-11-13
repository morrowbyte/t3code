// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it, vi } from "@effect/vitest";
import { DesktopBrowserEvent, type DesktopBrowserPrivateEntryAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePrivateCdpReply = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeBrowserAttachment = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ result: Schema.Struct({ sessionId: Schema.String }) })),
);
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };
/** Sends a page command whose id the fake debugger records as it receives it. */
const command = (
  connection: Pick<DesktopBrowserHost.DesktopBrowserConnection, "handleCommandLine">,
  id: number,
  method: string,
) =>
  connection.handleCommandLine(
    encodeJson({
      type: "cdp",
      ...key,
      message: encodeJson({ id, method, params: { id }, sessionId: "t3-preview-page" }),
    }),
  );

const makeDebuggee = (
  options: {
    readonly deferFocus?: boolean;
    readonly refuse?: (method: string, sessionId: string | undefined) => boolean;
  } = {},
) => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const focusChanges: Array<() => void> = [];
  const sent: Array<unknown> = [];
  const sentMethods: Array<string> = [];
  const sendWaiters: Array<() => void> = [];
  const focusEmulation: Array<boolean> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (
      method: string,
      params?: { id?: number; enabled?: boolean },
      sessionId?: string,
    ) =>
      new Promise((resolve, reject) => {
        sentMethods.push(method);
        if (options.refuse?.(method, sessionId)) {
          reject(new Error("Refused"));
          return;
        }
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        if (method === "Emulation.setFocusEmulationEnabled") {
          focusEmulation.push(params?.enabled === true);
          if (options.deferFocus) focusChanges.push(() => resolve({}));
          else resolve({});
          return;
        }
        sent.push(params?.id);
        pending.push(() => resolve({ method }));
        sendWaiters.shift()?.();
      }),
  });
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  });
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    navigate: () => webContents.emit("did-navigate"),
    /** Ids of the commands the debugger received, in order. */
    sent,
    sentMethods,
    focusEmulation,
    nextSend: () => new Promise<void>((resolve) => sendWaiters.push(resolve)),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    releaseFirst: () => pending.shift()?.(),
    settleFocus: () => focusChanges.splice(0).forEach((resolve) => resolve()),
  };
};

/** Commands wait behind a focus emulation change; it settles within a macrotask. */
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

const connect = Effect.fn(function* (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  environmentId?: string,
) {
  const connection = host.createConnection(environmentId);
  const messages = yield* Queue.unbounded<typeof DesktopBrowserEvent.Type>();
  yield* connection.events.pipe(
    Stream.runForEach((line) => Queue.offer(messages, decodeEvent(new TextDecoder().decode(line)))),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return { connection, messages };
});
const grant = Effect.fn(function* (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  backend: {
    connection: DesktopBrowserHost.DesktopBrowserConnection;
    messages: Queue.Queue<typeof DesktopBrowserEvent.Type>;
  },
  source: Electron.WebContents,
) {
  const acquiring = yield* Effect.tryPromise(() => host.acquirePrivateEntry(source)).pipe(
    Effect.forkScoped,
  );
  const request = yield* Queue.take(backend.messages);
  if (request.type !== "private-entry-acquire") throw new Error("Expected acquire");
  const response = {
    ...request,
    type: "private-entry-granted",
    leaseId: "owned-lease",
    generation: 7,
  };
  yield* backend.connection.handleCommandLine(encodeJson(response));
  return { lease: yield* Fiber.join(acquiring), request, response };
});
/**
 * Ids of the replies the host sends, in order. A screenshot's reply leaves after its turn
 * has passed on, so by then the next waiting screenshot, if any, has been sent. Subscribe
 * before sending commands: a new subscriber releases the tab's relay.
 */
const watchReplies = (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) =>
  Effect.gen(function* () {
    const replies = yield* Queue.unbounded<number>();
    const connection = host.createConnection();
    yield* connection.events.pipe(
      Stream.map((line) => decodeEvent(new TextDecoder().decode(line))),
      Stream.runForEach((event) =>
        event.type === "cdp" ? Queue.offer(replies, decodeCdpReply(event.message).id) : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return { connection, replies };
  });

/** Whether the client should paint the guest, each time that changes. */
const watchPainting = (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) =>
  Effect.gen(function* () {
    const painting: Array<boolean> = [];
    yield* host.painting.pipe(
      Stream.runForEach(({ active }) => Effect.sync(() => painting.push(active))),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return painting;
  });

describe("DesktopBrowserHost", () => {
  it.effect("refuses unknown/unattached authority without sending an acquire", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(false);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise(() => host.acquirePrivateEntry(debuggee.tab.webContents)),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "processes matching release ACK while private and rejects wrong request/generation",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const backend = yield* connect(host);
        const debuggee = makeDebuggee();
        const restoration = {
          desktopHostId: "native-host",
          url: "https://example.com/current",
          title: "Current page",
          canGoBack: true,
          canGoForward: false,
          viewport: { _tag: "freeform" as const, width: 900, height: 700 },
          profileId: "default",
        };
        const getRestoration = vi.fn(() => restoration);
        host.attach(key, { ...debuggee.tab, getRestoration });
        expect(yield* Queue.take(backend.messages)).toMatchObject({
          type: "attached",
          restoration,
        });
        const { lease } = yield* grant(host, backend, debuggee.tab.webContents);
        host.setPrivateEntry(debuggee.tab.webContents, true);
        const releasing = yield* Effect.tryPromise(() => lease.release()).pipe(Effect.forkScoped);
        const request = yield* Queue.take(backend.messages);
        if (request.type !== "private-entry-release") throw new Error("Expected release");
        yield* backend.connection.handleCommandLine(
          encodeJson({ ...request, type: "private-entry-released", generation: 8 }),
        );
        yield* backend.connection.handleCommandLine(
          encodeJson({ ...request, type: "private-entry-released", requestId: "wrong" }),
        );
        expect(lease.current()).toBe(true);
        expect(releasing.pollUnsafe()).toBeUndefined();
        yield* backend.connection.handleCommandLine(
          encodeJson({ ...request, type: "private-entry-released" }),
        );
        const resume = yield* Fiber.join(releasing);
        expect(resume.current()).toBe(true);
        expect(lease.current()).toBe(false);
        // ACK alone never opens privacy; only Manager's verified clear can do so.
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
        yield* backend.connection.closed;
        const replacement = yield* connect(host);
        yield* Queue.take(replacement.messages);
        expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(true);
        expect(resume.current()).toBe(false);
        yield* backend.connection.closed;
        expect(resume.current()).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "command half-close invalidates a grant while input consumer lives and old close cannot invalidate replacement",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const changes = yield* Stream.toQueue(host.privateEntryChanges, { capacity: "unbounded" });
        const old = yield* connect(host);
        const debuggee = makeDebuggee();
        const getRestoration = vi.fn(() => ({
          desktopHostId: "native-host",
          title: "Public",
          canGoBack: false,
          canGoForward: false,
        }));
        host.attach(key, { ...debuggee.tab, getRestoration });
        expect(yield* Queue.take(old.messages)).toHaveProperty("restoration");
        const first = yield* grant(host, old, debuggee.tab.webContents);
        host.setPrivateEntry(debuggee.tab.webContents, true);
        expect(yield* Queue.take(changes)).toEqual({
          source: debuggee.tab.webContents,
          active: true,
        });
        host.setPrivateEntry(debuggee.tab.webContents, true);
        host.setPrivateEntry(debuggee.tab.webContents, false);
        expect(yield* Queue.take(changes)).toEqual({
          source: debuggee.tab.webContents,
          active: false,
        });
        yield* old.connection.closed;
        expect(yield* Queue.take(changes)).toEqual({
          source: debuggee.tab.webContents,
          active: true,
        });
        expect(first.lease.current()).toBe(false);
        expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(false);
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => first.lease.release()))),
        ).toBe(true);
        const current = yield* connect(host);
        const attached = yield* Queue.take(current.messages);
        expect(attached.type).toBe("attached");
        expect(attached).not.toHaveProperty("restoration");
        expect(getRestoration).toHaveBeenCalledTimes(1);
        expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(true);
        yield* old.connection.closed;
        yield* old.connection.handleCommandLine(encodeJson(first.response));
        expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(true);
        expect(first.lease.current()).toBe(false);
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "revokes the original acquisition while private and ignores stale attachment results",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const backend = yield* connect(host);
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        yield* Queue.take(backend.messages);
        const acquired = yield* grant(host, backend, debuggee.tab.webContents);
        host.setPrivateEntry(debuggee.tab.webContents, true);
        yield* backend.connection.handleCommandLine(
          encodeJson({
            ...acquired.response,
            type: "private-entry-revoked",
            reason: "control-changed",
            attachmentId: "stale",
          }),
        );
        expect(acquired.lease.current()).toBe(true);
        yield* backend.connection.handleCommandLine(
          encodeJson({
            ...acquired.response,
            type: "private-entry-revoked",
            reason: "control-changed",
          }),
        );
        expect(acquired.lease.current()).toBe(false);
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a legacy no-reply timeout cancels the original request and never accepts its late grant",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const backend = yield* connect(host);
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        yield* Queue.take(backend.messages);
        const acquiring = yield* Effect.exit(
          Effect.tryPromise(() => host.acquirePrivateEntry(debuggee.tab.webContents)),
        ).pipe(Effect.forkScoped);
        const request = yield* Queue.take(backend.messages);
        if (request.type !== "private-entry-acquire") throw new Error("Expected acquire");
        yield* TestClock.adjust("5 seconds");
        expect(Exit.isFailure(yield* Fiber.join(acquiring))).toBe(true);
        const cancelled = yield* Queue.take(backend.messages);
        expect(cancelled).toMatchObject({
          type: "private-entry-cancel",
          requestId: request.requestId,
        });
        yield* backend.connection.handleCommandLine(
          encodeJson({
            ...request,
            type: "private-entry-granted",
            leaseId: "late",
            generation: 1,
          }),
        );
        expect((yield* Queue.take(backend.messages)).type).toBe("private-entry-cancel");
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              Effect.tryPromise(() => host.acquirePrivateEntry(debuggee.tab.webContents)),
            ),
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "private entry blocks read-only CDP and events and drops pre-entry replies even after resume",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee({
          refuse: (_method, sessionId) => sessionId?.startsWith("t3-preview-browser-") === true,
        });
        host.attach(key, debuggee.tab);
        const { connection, messages } = yield* connect(host);
        yield* Queue.take(messages);
        const browserAttach = yield* connection.dispatchCommandLine!(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id: 90, method: "Target.attachToBrowserTarget" }),
          }),
        );
        yield* Effect.promise(() => browserAttach!.settled);
        const browserEvent = yield* Queue.take(messages);
        if (browserEvent.type !== "cdp") throw new Error("Expected browser attachment");
        const browser = yield* decodeBrowserAttachment(browserEvent.message);
        const command = (id: number, method: string) =>
          connection.dispatchCommandLine!(
            encodeJson({
              type: "cdp",
              ...key,
              message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
            }),
          );
        const screenshotSent = debuggee.nextSend();
        const screenshot = yield* command(1, "Page.captureScreenshot");
        yield* Effect.promise(() => screenshotSent);
        host.setPrivateEntry(debuggee.tab.webContents, true);
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
        yield* command(2, "DOM.getDocument");
        debuggee.emit("Runtime.consoleAPICalled", { value: "fake-secret-must-not-relay" });
        yield* connection.handleCommandLine(encodeJson({ type: "release", ...key }));
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
        host.setPrivateEntry(debuggee.tab.webContents, false);
        const pageAttach = yield* connection.dispatchCommandLine!(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({
              id: 91,
              method: "Target.attachToTarget",
              params: { targetId: "GUEST", flatten: true },
              sessionId: browser.result.sessionId,
            }),
          }),
        );
        yield* Effect.promise(() => pageAttach!.settled);
        const resumedSent = debuggee.nextSend();
        const resumed = yield* command(3, "DOM.enable");
        yield* Effect.promise(() => resumedSent);
        debuggee.release();
        yield* Effect.promise(() => Promise.all([screenshot!.settled, resumed!.settled]));
        const events = [
          yield* Queue.take(messages),
          yield* Queue.take(messages),
          yield* Queue.take(messages),
        ];
        expect(
          events.map((entry) => decodeCdpReply((entry as { message: string }).message).id),
        ).toEqual([2, 91, 3]);
        const resumedAttachment = events[1];
        if (resumedAttachment?.type !== "cdp") throw new Error("Expected resumed page attachment");
        expect(JSON.parse(resumedAttachment.message)).toMatchObject({
          id: 91,
          result: { sessionId: expect.stringMatching(/^t3-preview-page-/) },
          sessionId: browser.result.sessionId,
        });
        const refusal = events[0];
        expect(refusal).toMatchObject({ type: "cdp", ...key });
        if (refusal?.type !== "cdp") throw new Error("Expected private CDP refusal");
        const response = yield* decodePrivateCdpReply(refusal.message);
        expect(response).toEqual({
          id: 2,
          sessionId: "t3-preview-page",
          error: { code: -32000, message: "This tab is private during credential entry." },
        });
        expect(JSON.stringify(events)).toContain("private during credential entry");
        expect(JSON.stringify(events)).not.toContain("fake-secret-must-not-relay");
        expect(debuggee.sentMethods).not.toContain("DOM.getDocument");
      }).pipe(Effect.scoped),
  );

  it.effect.each([undefined, "environment-a"])(
    "isolates same-ID targets across private resume, replacement and half-close: %s",
    (environmentId) =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        expect(host.hostedEnvironmentIds()).toEqual([]);
        const debuggee = makeDebuggee();
        const otherDebuggee = makeDebuggee();
        const targetKey = { ...key, ...(environmentId === undefined ? {} : { environmentId }) };
        const otherKey = { ...key, environmentId: "environment-b" };
        host.attach(targetKey, debuggee.tab);
        const old = yield* connect(host, environmentId);
        expect(host.hostedEnvironmentIds()).toEqual(
          environmentId === undefined ? [] : [environmentId],
        );
        const attached = yield* Queue.take(old.messages);
        expect(attached).toEqual({ type: "attached", ...key, privateEntry: expect.any(Object) });
        const acquired = yield* grant(host, old, debuggee.tab.webContents);
        host.attach(otherKey, otherDebuggee.tab);
        const other = yield* connect(host, otherKey.environmentId);
        const hosted = [
          ...(environmentId === undefined ? [] : [environmentId]),
          otherKey.environmentId,
        ];
        expect(host.hostedEnvironmentIds()).toEqual(hosted);
        expect(yield* Queue.take(other.messages)).toEqual({
          type: "attached",
          ...key,
          privateEntry: expect.any(Object),
        });
        expect(acquired.lease.current()).toBe(true);
        expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(true);
        expect(yield* Queue.size(old.messages)).toBe(0);
        const otherAcquired = yield* grant(host, other, otherDebuggee.tab.webContents);
        yield* old.connection.handleCommandLine(
          encodeJson({
            ...otherAcquired.response,
            type: "private-entry-revoked",
            reason: "closed",
          }),
        );
        yield* other.connection.handleCommandLine(
          encodeJson({ ...acquired.response, type: "private-entry-revoked", reason: "closed" }),
        );
        expect(acquired.lease.current()).toBe(true);
        expect(otherAcquired.lease.current()).toBe(true);
        const line = (id: number) =>
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method: "DOM.enable", sessionId: "t3-preview-page" }),
          });
        const sent = debuggee.nextSend();
        const pending = yield* old.connection.dispatchCommandLine!(line(200));
        expect(pending).toBeDefined();
        yield* Effect.promise(() => sent);
        const otherSent = otherDebuggee.nextSend();
        const otherPending = yield* other.connection.dispatchCommandLine!(line(300));
        yield* Effect.promise(() => otherSent);
        expect(debuggee.sent).toEqual([undefined]);
        expect(otherDebuggee.sent).toEqual([undefined]);
        host.setPrivateEntry(debuggee.tab.webContents, true);
        host.setPrivateEntry(debuggee.tab.webContents, false);
        const replacement = yield* connect(host, environmentId);
        expect([...host.hostedEnvironmentIds()].sort()).toEqual([...hosted].sort());
        const replacementAttached = yield* Queue.take(replacement.messages);
        expect(replacementAttached).toMatchObject({ type: "attached", ...key });
        expect(replacementAttached).not.toEqual(attached);
        yield* replacement.connection.handleCommandLine(encodeJson({ type: "reattach", ...key }));
        expect(yield* Queue.take(replacement.messages)).toMatchObject({ type: "attached", ...key });
        expect(acquired.lease.current()).toBe(false);
        expect(otherAcquired.lease.current()).toBe(true);
        expect(yield* Queue.size(other.messages)).toBe(0);
        host.setPrivateEntry(debuggee.tab.webContents, false);
        const currentAcquired = yield* grant(host, replacement, debuggee.tab.webContents);
        yield* replacement.connection.handleCommandLine(encodeJson(acquired.response));
        expect(acquired.lease.current()).toBe(false);
        expect(currentAcquired.lease.current()).toBe(true);
        yield* old.connection.closed;
        yield* old.connection.closed;
        yield* old.connection.handleCommandLine(line(202));
        expect(yield* old.connection.dispatchCommandLine!(line(202))).toBeUndefined();
        const currentSent = debuggee.nextSend();
        const current = yield* replacement.connection.dispatchCommandLine!(line(201));
        yield* Effect.promise(() => currentSent);
        debuggee.release();
        yield* Effect.promise(() => pending!.settled);
        yield* Effect.promise(() => current!.settled);
        const reply = yield* Queue.take(replacement.messages);
        expect(reply.type === "cdp" && decodeCdpReply(reply.message).id).toBe(201);
        expect(yield* Queue.size(replacement.messages)).toBe(0);
        expect(yield* Queue.size(other.messages)).toBe(0);
        otherDebuggee.release();
        yield* Effect.promise(() => otherPending!.settled);
        const otherReply = yield* Queue.take(other.messages);
        expect(otherReply.type === "cdp" && decodeCdpReply(otherReply.message).id).toBe(300);
        const halfClosedSent = debuggee.nextSend();
        const halfClosed = yield* replacement.connection.dispatchCommandLine!(line(203));
        yield* Effect.promise(() => halfClosedSent);
        yield* replacement.connection.closed;
        expect(host.hostedEnvironmentIds()).toEqual([otherKey.environmentId]);
        expect(currentAcquired.lease.current()).toBe(false);
        expect(otherAcquired.lease.current()).toBe(true);
        debuggee.release();
        yield* Effect.promise(() => halfClosed!.settled);
        expect(yield* replacement.connection.dispatchCommandLine!(line(204))).toBeUndefined();
        const survivingSent = otherDebuggee.nextSend();
        const surviving = yield* other.connection.dispatchCommandLine!(line(301));
        yield* Effect.promise(() => survivingSent);
        otherDebuggee.release();
        yield* Effect.promise(() => surviving!.settled);
        const survivingReply = yield* Queue.take(other.messages);
        expect(survivingReply.type === "cdp" && decodeCdpReply(survivingReply.message).id).toBe(
          301,
        );
        expect(yield* Queue.size(replacement.messages)).toBe(0);
        expect(yield* Queue.size(other.messages)).toBe(0);
        expect(debuggee.sent).toHaveLength(3);
        expect(otherDebuggee.sent).toHaveLength(2);
        host.detach(targetKey);
        expect(otherAcquired.lease.current()).toBe(true);
        yield* other.connection.closed;
        expect(host.hostedEnvironmentIds()).toEqual([]);
        expect(otherAcquired.lease.current()).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("binds the existing guest session before announcing its remote target", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const entered = Promise.withResolvers<void>();
      const applied = Promise.withResolvers<void>();
      let beforeRequest: ((callback: (result: { cancel: boolean }) => void) => void) | undefined;
      const requestBlocked = () => {
        let cancelled = false;
        beforeRequest?.((result) => {
          cancelled = result.cancel;
        });
        return cancelled;
      };
      const session = {
        webRequest: {
          onBeforeRequest: vi.fn(
            (
              _filter: unknown,
              listener: (
                _request: unknown,
                callback: (result: { cancel: boolean }) => void,
              ) => void,
            ) => {
              beforeRequest = (callback) => listener({}, callback);
            },
          ),
        },
        setProxy: vi.fn(async () => {
          entered.resolve();
          await applied.promise;
        }),
        closeAllConnections: vi.fn(async () => {}),
      };
      Object.defineProperty(debuggee.tab.webContents, "session", { value: session });
      const targetKey = { ...key, environmentId: "remote-network" };
      host.attach(targetKey, debuggee.tab);
      const connection = host.createConnection(targetKey.environmentId, "socks5://127.0.0.1:39001");
      const messages = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* connection.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(messages, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => entered.promise);
      expect(requestBlocked()).toBe(true);
      expect(yield* Queue.size(messages)).toBe(0);
      applied.resolve();
      expect(yield* Queue.take(messages)).toMatchObject({ type: "attached", ...key });
      expect(session.setProxy).toHaveBeenCalledWith({
        mode: "fixed_servers",
        proxyRules: "socks5://127.0.0.1:39001",
        proxyBypassRules: "<-loopback>",
      });
      yield* Effect.promise(() =>
        host.configureTargetSession(targetKey.environmentId, debuggee.tab.webContents.session),
      );
      expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(session.setProxy).toHaveBeenCalledTimes(1);
      expect(requestBlocked()).toBe(false);
      yield* connection.closed;
      expect(requestBlocked()).toBe(true);
      expect(session.closeAllConnections).toHaveBeenCalledTimes(2);
      yield* Effect.promise(() =>
        expect(
          host.configureTargetSession(
            targetKey.environmentId,
            debuggee.tab.webContents.session,
            true,
          ),
        ).rejects.toThrow("The remote browser network is disconnected."),
      );
      const replacement = host.createConnection(
        targetKey.environmentId,
        "socks5://127.0.0.1:39001",
      );
      const replacementEntered = Promise.withResolvers<void>();
      const replacementApplied = Promise.withResolvers<void>();
      session.setProxy.mockImplementationOnce(async () => {
        replacementEntered.resolve();
        await replacementApplied.promise;
      });
      yield* replacement.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(messages, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => replacementEntered.promise);
      expect(requestBlocked()).toBe(true);
      expect(yield* Queue.size(messages)).toBe(0);
      replacementApplied.resolve();
      expect(yield* Queue.take(messages)).toMatchObject({ type: "attached", ...key });
      expect(session.setProxy).toHaveBeenLastCalledWith({
        mode: "fixed_servers",
        proxyRules: "socks5://127.0.0.1:39001",
        proxyBypassRules: "<-loopback>",
      });
      expect(session.closeAllConnections).toHaveBeenCalledTimes(3);
      expect(requestBlocked()).toBe(false);
      yield* connection.closed;
      expect(requestBlocked()).toBe(false);
      expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      let title = "Original document";
      let destroyed = false;
      debuggee.tab.webContents.isDestroyed = () => destroyed;
      const getRestoration = vi.fn(() => ({
        desktopHostId: "native-host",
        title,
        canGoBack: false,
        canGoForward: false,
      }));
      host.attach(key, { ...debuggee.tab, getRestoration });
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toMatchObject([
        { type: "attached", ...key, restoration: { title: "Original document" } },
      ]);
      title = "Current document";
      expect(yield* takeEvents(host, 1)).toMatchObject([
        { type: "attached", ...key, restoration: { title: "Current document" } },
      ]);
      const reads = getRestoration.mock.calls.length;
      destroyed = true;
      const [attached] = yield* takeEvents(host, 1);
      expect(attached).not.toHaveProperty("restoration");
      expect(getRestoration).toHaveBeenCalledTimes(reads);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      yield* settle;
      debuggee.release();
      const [, reply] = yield* Fiber.join(reader);

      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "sends screenshots in order across a viewport change: %s",
    (resize) =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee();
        let revision = 0;
        host.attach(key, { ...debuggee.tab, captureRevision: () => revision });
        const { connection, messages } = yield* connect(host);
        yield* Queue.take(messages);

        yield* command(connection, 1, "Page.captureScreenshot");
        yield* command(connection, 2, "Page.captureScreenshot");
        yield* command(connection, 3, "DOM.enable");
        yield* settle;
        expect(debuggee.sent).toEqual([1, 3]);

        if (resize) revision += 2;
        debuggee.releaseFirst();
        const first = yield* Queue.take(messages);
        expect(first.type).toBe("cdp");
        if (first.type !== "cdp") throw new Error("Expected screenshot reply");
        const reply: unknown = JSON.parse(first.message);
        expect(reply).toMatchObject(
          resize
            ? {
                id: 1,
                error: { message: "The preview changed while its screenshot was being captured." },
              }
            : { id: 1, result: { method: "Page.captureScreenshot" } },
        );
        expect(debuggee.sent).toEqual([1, 3, 2]);
      }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "waits for viewport changes on an offscreen host: %s",
    (offscreen) =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee();
        const started = Promise.withResolvers<void>();
        const resized = Promise.withResolvers<void>();
        const setViewport = vi.fn(async () => {
          started.resolve();
          await resized.promise;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => resized.resolve()));
        host.attach(key, { ...debuggee.tab, ...(offscreen ? { setViewport } : {}) });
        const { connection, messages } = yield* connect(host);
        yield* Queue.take(messages);
        yield* connection.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({
              id: 1,
              method: "Emulation.setDeviceMetricsOverride",
              params: { id: 1, width: 1440, height: 1700, deviceScaleFactor: 0, mobile: false },
              sessionId: "t3-preview-page",
            }),
          }),
        );
        if (offscreen) {
          yield* Effect.promise(() => started.promise);
          expect(yield* Queue.size(messages)).toBe(0);
          expect(debuggee.sentMethods).not.toContain("Emulation.setDeviceMetricsOverride");
          resized.resolve();
        } else {
          yield* settle;
          expect(setViewport).not.toHaveBeenCalled();
          expect(debuggee.sentMethods).toContain("Emulation.setDeviceMetricsOverride");
          debuggee.release();
        }
        const reply = yield* Queue.take(messages);
        expect(reply.type === "cdp" && decodeCdpReply(reply.message).id).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("stops waiting on a screenshot the page navigated away from", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { connection, replies } = yield* watchReplies(host);

      yield* command(connection, 1, "Page.captureScreenshot");
      yield* command(connection, 2, "Page.captureScreenshot");
      yield* command(connection, 3, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      expect(debuggee.sent).toEqual([1, 2]);

      // The superseded screenshot answering late must not start a third beside the second.
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1, 2]);

      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(2);
      expect(debuggee.sent).toEqual([1, 2, 3]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops screenshots a released relay left waiting", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const releaseHold = vi.fn();
      const acquireCaptureHold = vi.fn(() => releaseHold);
      host.attach(key, { ...debuggee.tab, acquireCaptureHold });

      const { connection } = yield* watchReplies(host);
      yield* command(connection, 1, "Page.captureScreenshot");
      yield* command(connection, 2, "Page.captureScreenshot");
      yield* settle;
      yield* connection.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(connection, 3, "Page.captureScreenshot");
      expect(debuggee.sent).toEqual([1]);
      expect(acquireCaptureHold).toHaveBeenCalledTimes(1);
      expect(releaseHold).not.toHaveBeenCalled();

      const sent = debuggee.nextSend();
      debuggee.release();
      yield* Effect.promise(() => sent);
      expect(debuggee.sent).toEqual([1, 3]);
      expect(acquireCaptureHold).toHaveBeenCalledTimes(2);
      expect(releaseHold).toHaveBeenCalledTimes(1);
      debuggee.release();
      yield* settle;
      expect(releaseHold).toHaveBeenCalledTimes(2);
    }).pipe(Effect.scoped),
  );

  it.effect("emulates focus while the server drives a guest, then lets a hidden one throttle", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);

      yield* command(host, 1, "DOM.enable");
      yield* settle;
      expect(debuggee.focusEmulation).toEqual([true]);
      expect(debuggee.sent).toEqual([1]);
      debuggee.release();
      yield* settle;

      yield* TestClock.adjust("4 seconds");
      yield* command(host, 2, "Input.dispatchMouseEvent");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("4 seconds");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* TestClock.adjust("10 seconds");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      yield* command(host, 3, "Page.captureScreenshot");
      yield* settle;
      expect(debuggee.focusEmulation).toEqual([true, false, true]);
      expect(debuggee.sent).toEqual([1, 2, 3]);
    }),
  );

  it.effect("keeps a guest focused while a command it is running is still pending", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);

      // An evaluation awaiting the page's next frame, which a throttled guest never paints.
      yield* command(host, 1, "Runtime.evaluate");
      yield* settle;
      expect(debuggee.sent).toEqual([1]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(1);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a guest throttle once Chromium can no longer answer its pending command", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);

      yield* command(host, 1, "Runtime.evaluate");
      yield* settle;
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      // A command the old document never answers.
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      expect(debuggee.sent).toEqual([1, 2]);
      debuggee.navigate();
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false, true, false]);
    }),
  );

  it.effect("keeps a guest focused for the screenshot a navigation lets start", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      expect(debuggee.sent).toEqual([1, 2]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);
    }),
  );

  it.effect("never sends a screenshot a navigation superseded while focus was changing", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee({ deferFocus: true });
      host.attach(key, debuggee.tab);
      yield* connect(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      debuggee.settleFocus();
      yield* settle;
      // Two captures in flight would undo the one-at-a-time guard.
      expect(debuggee.sent).toEqual([2]);
    }),
  );

  it.effect("keeps a guest focused when its turn starts after the agent's first command", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      yield* command(host, 1, "Input.dispatchKeyEvent");
      yield* settle;
      yield* turn(true);
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* turn(false);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }),
  );

  it.effect("lets a guest throttle through a turn that only sent it housekeeping", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);
      yield* host.handleCommandLine(
        encodeJson({ type: "turn", threadId: key.threadId, active: true }),
      );

      // Playwright re-enabling a domain after a reload is not the agent using the tab.
      yield* command(host, 1, "Runtime.enable");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      yield* command(host, 2, "Runtime.evaluate");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false, true]);
    }),
  );

  it.effect("keeps a guest the agent used focused through its turn's pauses", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      yield* turn(true);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([]);

      yield* command(host, 1, "Input.dispatchKeyEvent");
      yield* settle;
      debuggee.release();
      yield* settle;
      // The model thinks between steps; a focus-sensitive menu must not blur meanwhile.
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* turn(false);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }),
  );

  it.effect(
    "ends a command's hold with the turn that sent it, even if Chromium never answers",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        yield* connect(host);
        yield* host.handleCommandLine(
          encodeJson({ type: "turn", threadId: key.threadId, active: true }),
        );

        // A screenshot of a hidden guest the server already gave up on.
        yield* command(host, 1, "Page.captureScreenshot");
        yield* settle;
        expect(debuggee.sent).toEqual([1]);
        yield* host.handleCommandLine(
          encodeJson({ type: "turn", threadId: key.threadId, active: false }),
        );
        yield* TestClock.adjust("1 minute");
        expect(debuggee.focusEmulation).toEqual([true, false]);
      }),
  );

  it.effect("ends the agent's own session's holds with its turn, but not a viewer's stream", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      // The server's own CDP session, evaluating a promise that never settles.
      yield* turn(true);
      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Runtime.evaluate", sessionId: "t3-preview-page-1" });
      yield* settle;
      yield* turn(false);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      // A viewer streaming the guest keeps it focused through a turn's end.
      yield* turn(true);
      yield* raw({ id: 3, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(3);
      yield* raw({ id: 4, method: "Page.startScreencast", sessionId: "t3-preview-page-2" });
      yield* settle;
      yield* turn(false);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false, true]);
    }).pipe(Effect.scoped),
  );

  it.effect("paints for a screenshot queued behind one its viewer abandoned mid-capture", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const painting = yield* watchPainting(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* settle;
      yield* raw({
        id: 3,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      expect(yield* Queue.take(replies)).toBe(3);
      expect(painting).toEqual([true, false]);

      // The agent's screenshot waits its turn; painting lets the abandoned one finish first.
      yield* command(host, 4, "Page.captureScreenshot");
      yield* settle;
      expect(painting).toEqual([true, false, true]);
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(2);
      yield* settle;
      expect(debuggee.sent).toEqual([undefined, 4]);
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(4);
      yield* settle;
      expect(painting).toEqual([true, false, true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops painting for a queued screenshot once its session detaches", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const painting = yield* watchPainting(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      // The agent's screenshot is abandoned at turn end; a viewer's waits behind it, then leaves.
      yield* turn(true);
      yield* command(host, 1, "Page.captureScreenshot");
      yield* settle;
      yield* turn(false);
      yield* raw({ id: 2, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(2);
      yield* raw({ id: 3, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* settle;
      expect(painting).toEqual([true, false, true]);
      yield* raw({
        id: 4,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      expect(yield* Queue.take(replies)).toBe(4);
      expect(painting).toEqual([true, false, true, false]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("never sends a screenshot whose session detached while focus was changing", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee({ deferFocus: true });
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* raw({
        id: 3,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      expect(yield* Queue.take(replies)).toBe(3);
      debuggee.settleFocus();
      yield* settle;
      expect(debuggee.sent).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops painting for a screenshot still queued when the agent's turn ends", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);
      const painting = yield* watchPainting(host);
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      yield* turn(true);
      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      yield* turn(false);
      yield* settle;
      expect(painting).toEqual([true, false]);

      // The first answers late; the second still goes in turn, but holds nothing.
      debuggee.releaseFirst();
      yield* settle;
      expect(debuggee.sent).toEqual([1, 2]);
      expect(painting).toEqual([true, false]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a guest throttle when Chromium refuses a viewer's screencast", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee({ refuse: (method) => method === "Page.startScreencast" });
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const painting = yield* watchPainting(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      expect(yield* Queue.take(replies)).toBe(2);
      yield* settle;
      expect(painting).toEqual([true, false]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a guest throttle after a person's input through a viewer that then closed", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* host.handleCommandLine(
        encodeJson({ type: "turn", threadId: key.threadId, active: true }),
      );
      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      yield* raw({ id: 3, method: "Input.dispatchMouseEvent", sessionId: "t3-preview-page-1" });
      yield* settle;
      debuggee.release();
      yield* raw({
        id: 4,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a page's screencast when a child session's screencast is refused", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee({
        refuse: (method, sessionId) => method === "Page.startScreencast" && sessionId !== undefined,
      });
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.startScreencast", sessionId: "child-frame" });
      expect(yield* Queue.take(replies)).toBe(2);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a screencast that arrives on a session after it detached", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({
        id: 2,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      expect(yield* Queue.take(replies)).toBe(2);
      yield* raw({ id: 3, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a guest throttle once the session waiting on its command detaches", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      // A viewer's own CDP session, closed while its still of a hidden guest is pending.
      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* raw({
        id: 3,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("never sends a screenshot queued by a session that has since detached", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* command(host, 2, "Page.captureScreenshot");
      yield* raw({ id: 3, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* raw({
        id: 4,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      yield* settle;
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(4);
      // The dropped screenshot's error reply leaves as the first frees its turn.
      expect([yield* Queue.take(replies), yield* Queue.take(replies)]).toEqual([3, 2]);
      yield* settle;
      expect(debuggee.sent).toEqual([2]);

      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a streamed guest focused until its screencast ends", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);

      yield* command(host, 1, "Page.startScreencast");
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* command(host, 2, "Page.stopScreencast");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      // A viewer whose connection went away without stopping its screencast.
      yield* command(host, 3, "Page.startScreencast");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false, true, false]);
    }),
  );

  it.effect("keeps a guest focused while any of its screencasts runs", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      // Two viewers, or a viewer and a recording, each on its own session.
      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      yield* raw({ id: 2, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect([yield* Queue.take(replies), yield* Queue.take(replies)]).toEqual([1, 2]);
      yield* raw({ id: 3, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      yield* raw({ id: 4, method: "Page.startScreencast", sessionId: "t3-preview-page-2" });
      yield* raw({ id: 5, method: "Page.stopScreencast", sessionId: "t3-preview-page-1" });
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* raw({
        id: 6,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-2" },
      });
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("paints a hidden guest only while the screenshot it is taking is pending", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);
      const painting = yield* watchPainting(host);

      yield* command(host, 1, "DOM.enable");
      yield* settle;
      expect(painting).toEqual([]);

      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "Page.captureScreenshot");
      yield* settle;
      expect(painting).toEqual([true]);

      // The first answers once the guest paints; the queued one then takes its turn.
      debuggee.release();
      yield* settle;
      expect(debuggee.sent).toEqual([1, 2, 3]);
      debuggee.release();
      yield* settle;
      expect(painting).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops painting for a screenshot Chromium never answers", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);
      const painting = yield* watchPainting(host);
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      // The server gave up on it, and the agent's turn ends.
      yield* turn(true);
      yield* command(host, 1, "Page.captureScreenshot");
      yield* settle;
      yield* turn(false);
      yield* settle;
      expect(painting).toEqual([true, false]);

      // The page loads a new document, which also frees the screenshot turn.
      debuggee.navigate();
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      yield* settle;
      expect(painting).toEqual([true, false, true, false]);

      // The server releases the relay.
      yield* command(host, 3, "Page.captureScreenshot");
      yield* settle;
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* settle;
      expect(painting).toEqual([true, false, true, false, true, false]);

      // The guest detaches; a replacement starts with no screenshot pending.
      const replacement = makeDebuggee();
      host.attach(key, replacement.tab);
      yield* command(host, 4, "Page.captureScreenshot");
      yield* settle;
      host.detach(key);
      yield* settle;
      expect(painting).toEqual([true, false, true, false, true, false, true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("paints a streamed guest until its last screencast ends", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { replies } = yield* watchReplies(host);
      const painting = yield* watchPainting(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      yield* raw({ id: 2, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect([yield* Queue.take(replies), yield* Queue.take(replies)]).toEqual([1, 2]);
      yield* raw({ id: 3, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      yield* raw({ id: 4, method: "Page.startScreencast", sessionId: "t3-preview-page-2" });
      yield* raw({ id: 5, method: "Page.stopScreencast", sessionId: "t3-preview-page-1" });
      yield* settle;
      debuggee.release();
      yield* settle;
      expect(painting).toEqual([true]);

      yield* raw({
        id: 6,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-2" },
      });
      yield* settle;
      expect(painting).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const { connection, replies } = yield* watchReplies(host);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;

      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      const sent = debuggee.nextSend();
      yield* connection.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      yield* Effect.promise(() => sent);
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(1);
      debuggee.emit("Page.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(makeDebuggee().tab.webContents, item)).toBe(false);
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual([NodePath.join("/srv/downloads", "guid-1")]);
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("tells a download the person clicked from one the agent's input started", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* connect(host);

      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({ id: 1, method: "DOM.getDocument", params: {} }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(true);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 1, y: 1 },
          }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(false);
    }),
  );

  it.effect("detaches only the tab whose CDP event is too large to relay", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const tabs = [makeDebuggee({ deferFocus: true }), makeDebuggee()];
      const send = vi.spyOn(tabs[0]!.tab.debugger, "sendCommand");
      const keys = [key, { threadId: "thread-2", tabId: "tab-2" }];
      const attachments: DesktopBrowserPrivateEntryAttachment[] = [];
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(events, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped,
      );
      for (const [index, tabKey] of keys.entries()) {
        host.attach(tabKey, tabs[index]!.tab);
        const attached = yield* Queue.take(events);
        expect(attached).toEqual({
          type: "attached",
          ...tabKey,
          privateEntry: {
            channelEpoch: expect.stringMatching(/\S/),
            attachmentId: expect.stringMatching(/\S/),
          },
        });
        if (attached.type !== "attached" || attached.privateEntry === undefined) {
          throw new Error("Expected a private-entry attachment");
        }
        attachments.push(attached.privateEntry);
        yield* host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...tabKey,
            message: encodeJson({ id: 1, method: "Target.setAutoAttach" }),
          }),
        );
        // The command's reply and the page announcement.
        yield* Queue.takeN(events, 2);
      }
      expect(attachments[1]!.channelEpoch).toBe(attachments[0]!.channelEpoch);
      expect(attachments[1]!.attachmentId).not.toBe(attachments[0]!.attachmentId);

      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Target.setAutoAttach",
            params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
            sessionId: "t3-preview-page",
          }),
        }),
      );
      yield* command(host, 3, "Page.startScreencast");
      tabs[0]!.emit("Runtime.consoleAPICalled", {
        args: Array(2048).fill("x".repeat(40 * 1024)),
      });
      tabs[1]!.emit("Page.loadEventFired", { timestamp: 1 });
      const [detached, next] = yield* Queue.takeN(events, 2);

      expect(detached).toEqual({ type: "detached", ...key, privateEntry: attachments[0] });
      expect(send).toHaveBeenCalledWith("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      tabs[0]!.settleFocus();
      yield* settle;
      expect(send).not.toHaveBeenCalledWith("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      expect(send).toHaveBeenCalledWith("Page.stopScreencast");
      expect(tabs[0]!.focusEmulation).toEqual([true, false]);
      expect(next).toMatchObject({ type: "cdp", ...keys[1] });
      expect(JSON.parse((next as { message: string }).message)).toMatchObject({
        method: "Page.loadEventFired",
      });
    }).pipe(Effect.scoped),
  );
});
