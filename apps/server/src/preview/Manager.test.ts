import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type PreviewEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as PreviewManager from "./Manager.ts";

const DRAIN_LIMIT = 100;

interface EventCollector {
  readonly drain: Effect.Effect<ReadonlyArray<PreviewEvent>>;
}

/** The shared live layer retains state between tests; counts need unique thread ids. */
let nextThreadId = 0;
const freshThreadId = () => ThreadId.make(`thread-${++nextThreadId}`);

/** Subscribe synchronously before publishing so the forked consumer cannot miss events. */
const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const subscription = yield* manager.subscribeEvents;
  const collector: EventCollector = {
    drain: PubSub.takeUpTo(subscription, DRAIN_LIMIT),
  };
  return collector;
}).pipe(Effect.withSpan("preview.test.collectEvents"));

const layer = PreviewManager.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-manager-" })),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(NodeServices.layer),
);

it.layer(layer)("PreviewManager", (it) => {
  it.effect("opens a session and emits opened with normalized URL", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const snapshot = yield* manager.open({ threadId, url: "localhost:5173" });
      expect(snapshot.tabId.startsWith("tab_")).toBe(true);
      expect(snapshot.navStatus._tag).toBe("Loading");
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/");
      }

      const events = yield* collector.drain;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("opened");
      if (events[0]?.type === "opened") {
        expect(events[0].tabId).toBe(snapshot.tabId);
      }
    }),
  );

  it.effect("restores desktop tabs and keeps their profile across status reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const before = yield* manager.list({ threadId });
      expect(before.sessions).toEqual([]);
      const input = {
        threadId,
        tabId: "tab_existing-main-guest",
        desktopHostId: "main-runtime-tab-7",
        profileId: "work",
        viewport: { _tag: "freeform" as const, width: 1024, height: 768 },
        url: "localhost:5173",
        title: "Existing page",
        canGoBack: true,
        canGoForward: true,
      };
      const restored = yield* manager.restoreDesktopTab(input);
      expect(restored).toMatchObject({
        threadId,
        tabId: input.tabId,
        desktopHostId: input.desktopHostId,
        profileId: input.profileId,
        viewport: input.viewport,
        runtime: "desktop",
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: input.title },
        canGoBack: true,
        canGoForward: true,
      });
      expect(restored.updatedAt).toEqual(expect.any(String));
      expect(restored).not.toHaveProperty("automationOwner");
      expect(restored).not.toHaveProperty("revealRequest");
      const restoredList = yield* manager.list({ threadId });
      expect(restoredList.sessions).toEqual([restored]);
      expect(restoredList.revision).toBe(before.revision + 1);
      expect(yield* collector.drain).toEqual([
        {
          type: "opened",
          threadId,
          tabId: input.tabId,
          createdAt: restored.updatedAt,
          serverEpoch: restoredList.serverEpoch,
          revision: restoredList.revision,
          snapshot: restored,
        },
      ]);

      yield* manager.reportStatus({
        threadId,
        tabId: restored.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/ready", title: "Dev" },
        canGoBack: true,
        canGoForward: false,
      });
      const healthy = yield* manager.list({ threadId });
      expect(healthy.sessions[0]?.profileId).toBe("work");
      yield* collector.drain;
      const repeated = yield* manager.restoreDesktopTab({ ...input, url: "invalid://stale" });
      expect(repeated).toBe(healthy.sessions[0]);
      expect(yield* manager.list({ threadId })).toEqual(healthy);
      expect(yield* collector.drain).toEqual([]);

      const opened = yield* manager.open({ threadId, profileId: "personal" });
      yield* collector.drain;
      for (const conflict of [
        { ...input, desktopHostId: "different-main-runtime-tab" },
        { ...input, tabId: opened.tabId },
        { ...input, threadId: freshThreadId() },
      ]) {
        const original = yield* manager.list({ threadId });
        const other = yield* manager.list({ threadId: conflict.threadId });
        const error = yield* manager.restoreDesktopTab(conflict).pipe(Effect.flip);
        expect(error._tag).toBe("PreviewControlRequiredError");
        expect(yield* manager.list({ threadId })).toEqual(original);
        expect(yield* manager.list({ threadId: conflict.threadId })).toEqual(other);
        expect(yield* collector.drain).toEqual([]);
      }

      const bound = yield* manager.bindDesktopTab({ threadId, tabId: opened.tabId, desktopHostId: "initial-main-host" });
      expect(bound.profileId).toBe("personal");
      expect(bound.desktopHostId).toBe("initial-main-host");
      yield* collector.drain;
      expect(yield* manager.bindDesktopTab({ threadId, tabId: opened.tabId, desktopHostId: "initial-main-host" })).toBe(bound);
      expect(yield* collector.drain).toEqual([]);
      const bindingError = yield* manager.bindDesktopTab({ threadId, tabId: opened.tabId, desktopHostId: "foreign-main-host" }).pipe(Effect.flip);
      expect(bindingError._tag).toBe("PreviewControlRequiredError");
      expect((yield* manager.list({ threadId })).sessions.find((snapshot) => snapshot.tabId === opened.tabId)).toBe(bound);
      expect(yield* collector.drain).toEqual([]);

      const idle = yield* manager.restoreDesktopTab({
        threadId,
        tabId: "tab_existing-empty-guest",
        desktopHostId: "main-runtime-tab-8",
        title: "",
        canGoBack: false,
        canGoForward: false,
      });
      expect(idle.navStatus).toEqual({ _tag: "Idle" });
      expect(idle.runtime).toBe("desktop");
      expect(idle.viewport).toEqual({ _tag: "fill" });
    }),
  );

  it.effect("reissues presentation requests without replaying them on navigation", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: true });
      const first = (yield* manager.list({ threadId })).sessions[0];
      expect(first?.reveal).toBe(true);
      expect(first?.revealRequest?.force).toBe(true);
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        serverControlled: true,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: false,
        canGoForward: false,
      });
      expect((yield* manager.list({ threadId })).sessions[0]?.revealRequest).toEqual(
        first?.revealRequest,
      );
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: false });
      const second = (yield* manager.list({ threadId })).sessions[0];
      expect(second?.revealRequest?.id).not.toBe(first?.revealRequest?.id);
      expect(second?.revealRequest?.force).toBe(false);
      const events = yield* collector.drain;
      const last = events.at(-1);
      expect(last?.type).toBe("navigated");
      if (last?.type === "navigated")
        expect(last.snapshot.revealRequest).toEqual(second?.revealRequest);
    }),
  );

  it.effect("orders list snapshots and events with one monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const before = yield* manager.list({ threadId });

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/ready", title: "Ready" },
        canGoBack: true,
        canGoForward: false,
      });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events[0]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[1]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[0]!.revision).toBeGreaterThan(before.revision);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(1);
    }),
  );

  it.effect("resizes a tab and preserves its viewport across navigation reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });

      const resized = yield* manager.resize({
        threadId,
        tabId: opened.tabId,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
      });
      expect(resized.viewport).toEqual({ _tag: "freeform", width: 1024, height: 768 });

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/resized", title: "Resized" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions[0]?.viewport).toEqual(resized.viewport);

      const events = yield* collector.drain;
      expect(events.map((event) => event.type)).toEqual(["opened", "resized", "navigated"]);
    }),
  );

  it.effect(
    "rejects client status reports for server tabs without changing state or emitting events",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
        const collector = yield* collectEvents;
        const before = yield* manager.list({ threadId });
        const input = {
          threadId,
          tabId: opened.tabId,
          navStatus: {
            _tag: "Success" as const,
            url: "http://localhost:5173/changed",
            title: "Changed",
          },
          canGoBack: true,
          canGoForward: true,
        };
        const rejected = yield* manager.reportStatus(input).pipe(Effect.flip);
        expect(rejected._tag).toBe("PreviewControlRequiredError");
        expect(yield* manager.list({ threadId })).toEqual(before);
        expect(yield* collector.drain).toEqual([]);

        yield* manager.reportStatus({ ...input, serverControlled: true });
        expect((yield* manager.list({ threadId })).sessions[0]).toMatchObject({
          navStatus: input.navStatus,
          canGoBack: true,
          canGoForward: true,
        });
        const events = yield* collector.drain;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "navigated",
          snapshot: { navStatus: input.navStatus },
        });
      }),
  );

  it.effect("gives every tab in a batch close its own monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });
      const collector = yield* collectEvents;

      yield* manager.close({ threadId });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.type === "closed")).toBe(true);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(0);
    }),
  );

  it.effect("close with explicit tabId removes only that tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000" });

      yield* manager.close({ threadId, tabId: a.tabId });

      const list = yield* manager.list({ threadId });
      expect(list.sessions.map((s) => s.tabId)).toEqual([b.tabId]);
    }),
  );
});
