import { describe, expect, it, vi } from "vite-plus/test";
import { startDesktopAfterRestore } from "./DesktopStartupGate.ts";

describe("desktop restore startup gate", () => {
  it("bootstraps in the same turn, before Electron can become ready", async () => {
    let ready = false;
    const events: string[] = [];
    const becomingReady = Promise.resolve().then(() => {
      ready = true;
      events.push("ready");
    });
    const restart = vi.fn<() => Promise<void>>();
    const exit = vi.fn();
    const reportError = vi.fn();
    expect(
      startDesktopAfterRestore({
        recover: () => false,
        start: () => {
          expect(ready).toBe(false);
          events.push("bootstrap");
        },
        restart,
        exit,
        reportError,
      }),
    ).toBeUndefined();
    expect(events).toEqual(["bootstrap"]);
    await becomingReady;
    expect(events).toEqual(["bootstrap", "ready"]);
    expect(restart).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "never bootstraps after an async gate: recovering=%s",
    async (recovering) => {
      const recovery = Promise.withResolvers<boolean>();
      const restarting = Promise.withResolvers<void>();
      const restarted = Promise.withResolvers<void>();
      const events: string[] = [];
      let ready = false;
      const becomingReady = Promise.resolve().then(() => {
        ready = true;
        events.push("ready");
      });
      const start = vi.fn(() => {
        expect(ready).toBe(false);
        events.push("bootstrap");
      });
      const reportError = vi.fn();
      const completion = startDesktopAfterRestore({
        recover: () => recovery.promise,
        start,
        restart: () => {
          expect(ready).toBe(true);
          events.push("restart");
          restarted.resolve();
          return restarting.promise;
        },
        exit: (code) => events.push(`exit:${code}`),
        reportError,
      });
      await becomingReady;
      expect(events).toEqual(["ready"]);
      recovery.resolve(recovering);
      if (!recovering) {
        await restarted.promise;
        expect(events).toEqual(["ready", "restart"]);
        restarting.resolve();
      }
      await completion;
      expect(events).toEqual(recovering ? ["ready", "exit:0"] : ["ready", "restart", "exit:0"]);
      expect(start).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it.each(["recover", "restart"] as const)(
    "reports a failed %s and exits without bootstrapping",
    async (phase) => {
      const failure = new Error("Desktop restore fixture failure.");
      const start = vi.fn();
      const reportError = vi.fn();
      const exit = vi.fn();
      await startDesktopAfterRestore({
        recover: () => (phase === "recover" ? Promise.reject(failure) : Promise.resolve(false)),
        start,
        restart: () => Promise.reject(failure),
        exit,
        reportError,
      });
      expect(start).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    },
  );
});
