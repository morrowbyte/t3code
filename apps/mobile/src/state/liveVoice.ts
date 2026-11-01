import { useSyncExternalStore } from "react";
import { LiveVoiceSessionOwner } from "@t3tools/client-runtime/live-voice";
import { createLiveVoiceEnvironmentAtoms } from "@t3tools/client-runtime/state/live-voice";
import type { createVoiceEventBridge } from "../features/live-voice/liveVoiceEvents";
import { connectionAtomRuntime } from "../connection/runtime";

export const liveVoiceEnvironment = createLiveVoiceEnvironmentAtoms(connectionAtomRuntime);
export const nativeLiveVoiceSession = new LiveVoiceSessionOwner<{
  readonly bridge: ReturnType<typeof createVoiceEventBridge>;
}>();

export function useNativeLiveVoiceSession() {
  return useSyncExternalStore(nativeLiveVoiceSession.subscribe, nativeLiveVoiceSession.getSnapshot);
}
