import { AppRegistry, AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { randomUUID } from "expo-crypto";

type VoiceStopped = { sessionId: string; reason: string };
interface VoiceBackgroundModule {
  addListener(
    name: "onVoiceSessionStopped",
    listener: (event: VoiceStopped) => void,
  ): { remove(): void };
  startVoiceSession?: (sessionId: string) => Promise<void>;
  stopVoiceSession?: (sessionId: string) => Promise<void>;
  isVoiceSessionActive?: (sessionId: string) => boolean;
}
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<VoiceBackgroundModule>("T3NativeControls")
    : null;
let activeSessionId: string | null = null;

if (Platform.OS === "android") {
  AppRegistry.registerHeadlessTask(
    "T3LiveVoice",
    () =>
      async ({ sessionId }: { sessionId: string }) => {
        if (!native?.isVoiceSessionActive?.(sessionId)) return;
        await new Promise<void>((resolve) => {
          const subscription = native.addListener("onVoiceSessionStopped", (event) => {
            if (event.sessionId === sessionId) {
              subscription.remove();
              resolve();
            }
          });
          if (!native.isVoiceSessionActive?.(sessionId)) {
            subscription.remove();
            resolve();
          }
        });
      },
  );
}

export function subscribeNativeVoiceStopped(onStopped: () => void) {
  const subscription = native?.startVoiceSession
    ? native.addListener("onVoiceSessionStopped", (event) => {
        if (event.sessionId === activeSessionId) onStopped();
      })
    : null;
  return () => subscription?.remove();
}

export async function beginNativeVoiceBackground(): Promise<() => Promise<void>> {
  if (Platform.OS !== "android") return async () => {};
  if (!native?.startVoiceSession || !native.stopVoiceSession || !native.isVoiceSessionActive) {
    throw new Error("Update the Android app to start background voice.");
  }
  if (AppState.currentState !== "active") throw new Error("Start voice from the visible app.");
  const sessionId = randomUUID();
  activeSessionId = sessionId;
  const stop = async () => {
    if (activeSessionId === sessionId) activeSessionId = null;
    await native.stopVoiceSession?.(sessionId);
  };
  try {
    await native.startVoiceSession(sessionId);
    if (!native.isVoiceSessionActive(sessionId)) throw new Error("The voice session has ended.");
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
