import type {
  LiveVoiceLease,
  LiveVoiceSignalEvent,
  LiveVoiceSignalingAdapter,
} from "@t3tools/client-runtime/live-voice";

type LeaseKey = Pick<LiveVoiceLease, "leaseId" | "generation">;
const keyOf = (lease: LeaseKey) => `${lease.leaseId}:${lease.generation}`;

export function createVoiceEventBridge() {
  const listeners = new Map<string, Set<(event: LiveVoiceSignalEvent) => void>>();
  const subscribe: LiveVoiceSignalingAdapter["subscribe"] = (lease, listener, signal) => {
    const key = keyOf(lease);
    let group = listeners.get(key);
    if (!group) listeners.set(key, (group = new Set()));
    return new Promise((resolve, reject) => {
      const unsubscribe = () => {
        signal.removeEventListener("abort", onAbort);
        group.delete(onEvent);
        if (group.size === 0) listeners.delete(key);
      };
      const onAbort = () => {
        unsubscribe();
        reject(new Error("Live voice setup was cancelled."));
      };
      const onEvent = (event: LiveVoiceSignalEvent) => {
        listener(event);
        if (
          event.type === "status" &&
          event.session.leaseId === lease.leaseId &&
          event.session.generation === lease.generation &&
          event.session.environmentId === lease.environmentId &&
          event.session.threadId === lease.threadId &&
          event.session.providerInstanceId === lease.providerInstanceId
        ) {
          signal.removeEventListener("abort", onAbort);
          resolve(unsubscribe);
        }
      };
      group.add(onEvent);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const publish = (lease: LeaseKey, event: LiveVoiceSignalEvent) => {
    listeners.get(keyOf(lease))?.forEach((listener) => listener(event));
  };
  return {
    subscribe,
    publish,
    publishUnavailable: (lease: LeaseKey) =>
      publish(lease, {
        type: "error",
        leaseId: lease.leaseId,
        generation: lease.generation,
        code: "runtime_unavailable",
      }),
  };
}
