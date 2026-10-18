import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { LiveVoiceLease } from "@t3tools/client-runtime/live-voice";
import { createVoiceEventBridge } from "./liveVoiceEvents";

const lease: LiveVoiceLease = {
  leaseId: "native-test",
  generation: 1,
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: null,
  plannerNativeThreadId: null,
  status: "prepared",
};

describe("native voice event subscription", () => {
  it("waits for the exact environment, thread and generation before admitting signaling", async () => {
    const bridge = createVoiceEventBridge();
    const ready = vi.fn();
    const listener = vi.fn();
    const subscribing = bridge
      .subscribe(lease, listener, new AbortController().signal)
      .then((unsubscribe) => {
        ready();
        return unsubscribe;
      });
    bridge.publish(lease, {
      type: "status",
      session: { ...lease, environmentId: EnvironmentId.make("environment-b") },
    });
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    bridge.publish(
      { ...lease, generation: 2 },
      { type: "status", session: { ...lease, generation: 2 } },
    );
    expect(listener).toHaveBeenCalledTimes(1);
    bridge.publish(lease, { type: "status", session: lease });
    const unsubscribe = await subscribing;
    expect(ready).toHaveBeenCalledOnce();
    unsubscribe();
    bridge.publishUnavailable(lease);
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it("removes a pending listener on cancel and rejects late events", async () => {
    const bridge = createVoiceEventBridge();
    const listener = vi.fn();
    const abort = new AbortController();
    const subscribing = bridge.subscribe(lease, listener, abort.signal);
    abort.abort();
    await expect(subscribing).rejects.toThrow("cancelled");
    bridge.publish(lease, { type: "status", session: lease });
    expect(listener).not.toHaveBeenCalled();
  });
});
