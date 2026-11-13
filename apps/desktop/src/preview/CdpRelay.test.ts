import { describe, expect, it, vi } from "vite-plus/test";

import {
  createCdpRelayConnection,
  createCdpRelaySessionState,
  type CdpRelayTarget,
} from "./CdpRelay.ts";

const makeTarget = (
  send: CdpRelayTarget["send"],
  setDownloadDirectory: CdpRelayTarget["setDownloadDirectory"] = () => {},
): CdpRelayTarget => ({
  send,
  targetId: async () => "GUEST-TARGET",
  url: () => "http://localhost:4719/",
  title: () => "Fixture",
  userAgent: () => "Electron",
  setDownloadDirectory,
});

const makeRelay = (target: CdpRelayTarget, write: (raw: string) => unknown) =>
  createCdpRelayConnection(target, write, () => {});

// Each relay reply resolves after a few microtasks; one macrotask lets them all land.
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("CDP relay", () => {
  it("announces only the tab's page, under its real target id", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(vi.fn()), (raw) => written.push(JSON.parse(raw)));
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.createTarget", params: {} }));
    await settle();
    const attach = written.findIndex((message) => message["id"] === 1);
    expect(written.slice(attach, attach + 2)).toEqual([
      { id: 1, result: {} },
      {
        method: "Target.attachedToTarget",
        params: expect.objectContaining({
          sessionId: "t3-preview-page",
          targetInfo: expect.objectContaining({ targetId: "GUEST-TARGET", type: "page" }),
        }),
      },
    ]);
    expect(written).toContainEqual({
      id: 2,
      error: expect.objectContaining({ message: expect.stringContaining("createTarget") }),
    });
  });

  it("forwards page commands to the tab and lets a slow one finish last", async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn(
      (method: string) =>
        new Promise<unknown>((resolve) => pending.push(() => resolve({ method }))),
    );
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(send), (raw) => written.push(JSON.parse(raw)));
    relay.receive(
      JSON.stringify({ id: 5, method: "Page.captureScreenshot", sessionId: "t3-preview-page" }),
    );
    relay.receive(JSON.stringify({ id: 6, method: "DOM.enable", sessionId: "iframe-session" }));
    pending[1]!();
    await settle();
    expect(written).toEqual([
      { id: 6, result: { method: "DOM.enable" }, sessionId: "iframe-session" },
    ]);
    pending[0]!();
    await settle();
    expect(send).toHaveBeenNthCalledWith(1, "Page.captureScreenshot", {}, undefined, undefined);
    expect(send).toHaveBeenNthCalledWith(2, "DOM.enable", {}, "iframe-session", undefined);
    expect(written.at(-1)).toEqual({
      id: 5,
      result: { method: "Page.captureScreenshot" },
      sessionId: "t3-preview-page",
    });
  });

  it("resumes paused child frames, so cross-site iframes run", async () => {
    const send = vi.fn(async () => ({}));
    const relay = makeRelay(makeTarget(send), () => {});
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "t3-preview-page",
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "iframe-session",
      }),
    );
    await settle();
    expect(send.mock.calls).toEqual([
      ["Runtime.runIfWaitingForDebugger", {}, "iframe-session", undefined],
    ]);
  });

  // Playwright enables focus emulation on every page it connects to, and Chromium then
  // counts the guest as captured: a preview the panel hides keeps its timers unthrottled.
  it("acknowledges Playwright's focus emulation without forcing it onto the guest", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(send), (raw) => written.push(JSON.parse(raw)));
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: true },
        sessionId: "t3-preview-page",
      }),
    );
    await settle();
    expect(written).toEqual([{ id: 1, result: {}, sessionId: "t3-preview-page" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("routes tab events to the page session once the page is announced", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(vi.fn()), (raw) => written.push(JSON.parse(raw)));
    relay.event("Page.loadEventFired", {}, undefined);
    expect(written).toEqual([]);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");
    relay.event("Runtime.consoleAPICalled", {}, "iframe-session");
    expect(written.slice(-2)).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "t3-preview-page" },
      { method: "Runtime.consoleAPICalled", params: {}, sessionId: "iframe-session" },
    ]);
  });
});

describe("CDP relay extra sessions", () => {
  it("gives a second page session the page's commands and events", async () => {
    const send = vi.fn<CdpRelayTarget["send"]>(async (_method, _params, sessionId) => {
      if (sessionId?.startsWith("t3-preview-browser-")) throw new Error("Unknown native session");
      return {};
    });
    const written: Array<Record<string, unknown>> = [];
    const state = createCdpRelaySessionState();
    const target = makeTarget(send);
    const write = (raw: string) => written.push(JSON.parse(raw));
    let relay = createCdpRelayConnection(target, write, () => {}, state);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
    await settle();
    const browserSession = (written.find((m) => m["id"] === 2)!["result"] as { sessionId: string })
      .sessionId;
    relay.receive(
      JSON.stringify({
        id: 3,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET", flatten: true },
        sessionId: browserSession,
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 4,
        method: "Target.attachToTarget",
        params: { targetId: "SOMETHING-ELSE" },
        sessionId: browserSession,
      }),
    );
    await settle();
    const extra = (written.find((m) => m["id"] === 3)!["result"] as { sessionId: string })
      .sessionId;
    expect(written.find((m) => m["id"] === 4)).toHaveProperty("error");
    relay.receive(JSON.stringify({ id: 5, method: "Page.startScreencast", sessionId: extra }));
    await settle();
    expect(send).toHaveBeenLastCalledWith("Page.startScreencast", {}, undefined, extra);
    written.length = 0;
    relay.event("Page.screencastFrame", { data: "x" }, undefined);
    expect(written.map((m) => m["sessionId"])).toEqual(["t3-preview-page", extra]);

    relay = createCdpRelayConnection(target, write, () => {}, state);
    await relay.receive(
      JSON.stringify({
        id: 7,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET" },
        sessionId: browserSession,
      }),
    );
    const resumed = (written.find((m) => m["id"] === 7)!["result"] as { sessionId: string })
      .sessionId;
    expect(resumed).not.toBe(extra);
    written.length = 0;
    relay.event("Page.screencastFrame", { data: "resumed" }, undefined);
    expect(written.map((m) => m["sessionId"])).toEqual(["t3-preview-page", resumed]);

    const replacement = createCdpRelayConnection(target, write, () => {});
    await replacement.receive(
      JSON.stringify({
        id: 8,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET" },
        sessionId: browserSession,
      }),
    );
    expect(written.find((m) => m["id"] === 8)).toHaveProperty("error");
  });
});

describe("CDP relay downloads", () => {
  it("captures preview downloads without changing the default browser context", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(
      makeTarget(send, (directory) => directories.push(directory)),
      (raw) => written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allowAndName",
          browserContextId: "t3-preview",
          downloadPath: "/srv/artifacts",
          eventsEnabled: true,
        },
      }),
    );
    await settle();
    expect(directories).toEqual(["/srv/artifacts"]);
    expect(send.mock.calls).toEqual([
      ["Page.setDownloadBehavior", { behavior: "default" }, undefined],
    ]);
    written.length = 0;
    relay.event("Page.downloadWillBegin", { guid: "g1", suggestedFilename: "r.csv" }, "");
    relay.event("Page.downloadProgress", { guid: "g1", state: "completed" }, "");
    expect(written).toEqual([
      { method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "r.csv" } },
      { method: "Browser.downloadProgress", params: { guid: "g1", state: "completed" } },
    ]);
  });

  it("keeps denial scoped to the preview and restores Electron's save handling when allowed", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const relay = makeRelay(
      makeTarget(send, (directory) => directories.push(directory)),
      () => {},
    );
    for (const [id, behavior] of ["deny", "allowAndName"].entries()) {
      relay.receive(
        JSON.stringify({
          id,
          method: "Browser.setDownloadBehavior",
          params: { behavior, downloadPath: "/srv/artifacts" },
        }),
      );
      await settle();
    }
    expect(directories).toEqual([null, "/srv/artifacts"]);
    expect(send.mock.calls).toEqual([
      ["Page.setDownloadBehavior", { behavior: "deny" }, undefined],
      ["Page.setDownloadBehavior", { behavior: "default" }, undefined],
    ]);
  });

  it("does not publish download events when the connection has disabled them", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(vi.fn(async () => ({}))), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: false },
      }),
    );
    await settle();
    written.length = 0;
    relay.event("Page.downloadWillBegin", { guid: "g1" }, "");
    relay.event("Page.downloadProgress", { guid: "g1", state: "completed" }, "");
    expect(written).toEqual([]);
  });

  it.each([false, true])(
    "keeps the previous download configuration (events enabled: %s) when configuration fails",
    async (enabled) => {
      const send = vi
        .fn(async () => ({}))
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("Page command rejected"));
      const written: Array<Record<string, unknown>> = [];
      let directory: string | null = null;
      const relay = makeRelay(
        makeTarget(send, (value) => {
          directory = value;
        }),
        (raw) => written.push(JSON.parse(raw)),
      );
      relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
      for (const [id, eventsEnabled] of [enabled, !enabled].entries()) {
        relay.receive(
          JSON.stringify({
            id: id + 2,
            method: "Browser.setDownloadBehavior",
            params: {
              behavior: id === 1 && enabled ? "deny" : "allowAndName",
              downloadPath: id === 0 ? "/srv/artifacts" : "/srv/new-artifacts",
              eventsEnabled,
            },
          }),
        );
        await settle();
      }
      expect(written).toContainEqual({
        id: 3,
        error: { code: -32000, message: "Page command rejected" },
      });
      expect(directory).toBe("/srv/artifacts");
      written.length = 0;
      relay.event("Page.downloadWillBegin", { guid: "g1" }, "");
      relay.event("Page.downloadProgress", { guid: "g1", state: "completed" }, "");
      expect(written).toEqual(
        enabled
          ? [
              { method: "Browser.downloadWillBegin", params: { guid: "g1" } },
              { method: "Browser.downloadProgress", params: { guid: "g1", state: "completed" } },
            ]
          : [],
      );
    },
  );
});

describe("per-command completion", () => {
  it("settles fast 201 independently of deferred 200 and waits for the actual sink", async () => {
    const slow = Promise.withResolvers<unknown>();
    const sink = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const ids: number[] = [];
    const relay = createCdpRelayConnection(
      makeTarget((method) => (method === "Runtime.evaluate" ? slow.promise : Promise.resolve({}))),
      async (raw) => {
        const id = (JSON.parse(raw) as { id: number }).id;
        ids.push(id);
        if (id === 200) {
          accepted.resolve();
          await sink.promise;
        }
      },
      () => {},
    );
    let settled = false;
    const pending = relay.receive(
      JSON.stringify({ id: 200, method: "Runtime.evaluate", sessionId: "t3-preview-page" }),
    )!;
    void pending.then(() => {
      settled = true;
    });
    await relay.receive(
      JSON.stringify({ id: 201, method: "DOM.enable", sessionId: "t3-preview-page" }),
    );
    expect(ids).toEqual([201]);
    slow.resolve({});
    await accepted.promise;
    expect(settled).toBe(false);
    sink.resolve();
    await pending;
    expect(ids).toEqual([201, 200]);
  });

  it("waits for reply acceptance before announcement and for announcement acceptance before settlement", async () => {
    const reply = Promise.withResolvers<void>();
    const announcement = Promise.withResolvers<void>();
    const announcing = Promise.withResolvers<void>();
    const calls: string[] = [];
    const relay = createCdpRelayConnection(
      makeTarget(async () => ({})),
      async (raw) => {
        if ("id" in JSON.parse(raw)) {
          calls.push("reply");
          await reply.promise;
        } else {
          calls.push("announcement");
          announcing.resolve();
          await announcement.promise;
        }
      },
      () => {},
    );
    let settled = false;
    const pending = relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach" }))!;
    void pending.then(() => {
      settled = true;
    });
    reply.resolve();
    await announcing.promise;
    expect(calls).toEqual(["reply", "announcement"]);
    expect(settled).toBe(false);
    announcement.resolve();
    await pending;
    expect(settled).toBe(true);
  });

  it("settles a target error only after its error reply is accepted and propagates sink failure", async () => {
    const accepted = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const relay = createCdpRelayConnection(
      makeTarget(async () => {
        throw new Error("synthetic");
      }),
      async (raw) => {
        expect(JSON.parse(raw)).toMatchObject({ id: 200, error: { code: -32000 } });
        entered.resolve();
        await accepted.promise;
      },
      () => {},
    );
    const pending = relay.receive(
      JSON.stringify({ id: 200, method: "Runtime.evaluate", sessionId: "t3-preview-page" }),
    )!;
    await entered.promise;
    accepted.reject(new Error("sink unavailable"));
    await expect(pending).rejects.toThrow("sink unavailable");
    expect(relay.receive("invalid")).toBeUndefined();
  });
});

describe("CDP relay payload budget", () => {
  // 2,048 references to one 40 KiB string: about 80 MiB once serialized, little memory here.
  const oversized = Array(2048).fill("x".repeat(40 * 1024));

  it("fails only an oversized reply and still returns a large screenshot", async () => {
    const screenshot = "A".repeat(16 * 1024 * 1024);
    const accepted = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const send = vi.fn(async (method: string) =>
      method === "DOM.getDocument" ? { nodes: oversized } : { data: screenshot },
    );
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(send), async (raw) => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      written.push(message);
      if (message["id"] === 1) {
        entered.resolve();
        await accepted.promise;
      }
    });
    let settled = false;
    const oversizedReply = relay.receive(
      JSON.stringify({ id: 1, method: "DOM.getDocument", sessionId: "t3-preview-page" }),
    )!;
    void oversizedReply.then(() => {
      settled = true;
    });
    const screenshotReply = relay.receive(
      JSON.stringify({ id: 2, method: "Page.captureScreenshot", sessionId: "t3-preview-page" }),
    );
    await entered.promise;
    await screenshotReply;
    expect(settled).toBe(false);
    accepted.resolve();
    await oversizedReply;
    expect(settled).toBe(true);

    const replies = written.map(({ id, error, result }) => ({
      id,
      error,
      size: (result as { data?: string } | undefined)?.data?.length,
    }));
    expect(replies).toEqual([
      { id: 1, error: { code: -32000, message: "CDP payload too large" }, size: undefined },
      { id: 2, error: undefined, size: screenshot.length },
    ]);
  });

  it.each([
    { args: oversized },
    { args: "\u0001".repeat(12 * 1024 * 1024) },
    { args: Array(2_700_000).fill(-0.0000010000000000000002) },
  ])("closes instead of dropping an oversized event (%#)", async ({ args }) => {
    const written: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const relay = createCdpRelayConnection(
      makeTarget(vi.fn()),
      (raw) => written.push(JSON.parse(raw)),
      close,
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    written.length = 0;

    relay.event("Runtime.consoleAPICalled", { args }, "");
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");

    relay.receive(JSON.stringify({ id: 2, method: "Target.setAutoAttach" }));
    expect(close).toHaveBeenCalledOnce();
    expect(written.map((message) => message["method"])).toEqual([]);
  });
});
