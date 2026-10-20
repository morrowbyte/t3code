import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const state = { active: null as string | null, appState: "active", granted: true, nextId: 0 };
  type Event = { sessionId: string; reason: string };
  const listeners = new Set<(event: Event) => void>();
  const emit = (sessionId: string) => {
    for (const listener of listeners) listener({ sessionId, reason: "notification" });
  };
  let headless: (() => (data: { sessionId: string }) => Promise<void>) | null = null;
  const native = {
    startVoiceSession: vi.fn(async (id: string) => {
      state.active = id;
    }),
    stopVoiceSession: vi.fn(async (id: string) => {
      if (state.active === id) {
        state.active = null;
        emit(id);
      }
    }),
    isVoiceSessionActive: (id: string) => state.active === id,
    addListener: (_name: string, listener: (event: Event) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  const getUserMedia = vi.fn();
  return {
    state,
    listeners,
    native,
    emit,
    getUserMedia,
    register: (_name: string, factory: NonNullable<typeof headless>) => {
      headless = factory;
    },
    getHeadless: () => headless,
  };
});
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    get currentState() {
      return mocks.state.appState;
    },
  },
  AppRegistry: { registerHeadlessTask: mocks.register },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `voice-${++mocks.state.nextId}` }));
vi.mock("expo-audio", () => ({
  getRecordingPermissionsAsync: async () => ({ granted: mocks.state.granted }),
  requestRecordingPermissionsAsync: async () => ({ granted: mocks.state.granted }),
}));
vi.mock("react-native-webrtc", () => ({
  mediaDevices: { getUserMedia: mocks.getUserMedia },
  MediaStream: vi.fn(),
  RTCPeerConnection: vi.fn(),
}));

import { beginNativeVoiceBackground, subscribeNativeVoiceStopped } from "./nativeVoiceBackground";
import { nativeVoiceMedia } from "./nativeVoiceMedia";

describe("Android user-started voice lifetime", () => {
  beforeEach(() => {
    mocks.state.active = null;
    mocks.state.appState = "active";
    mocks.state.granted = true;
    mocks.listeners.clear();
    vi.clearAllMocks();
  });

  it("never starts the microphone foreground service from the background", async () => {
    mocks.state.appState = "background";
    await expect(beginNativeVoiceBackground()).rejects.toThrow("visible app");
    expect(mocks.native.startVoiceSession).not.toHaveBeenCalled();
  });

  it("keeps its headless JS lifetime until the exact native call ends", async () => {
    const end = await beginNativeVoiceBackground();
    const sessionId = mocks.state.active!;
    let finished = false;
    const task = mocks.getHeadless()!()({ sessionId }).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    await end();
    await task;
    expect(finished).toBe(true);
    expect(mocks.native.stopVoiceSession).toHaveBeenCalledExactlyOnceWith(sessionId);
  });

  it("ignores stale stop events and stale cleanup after a new call starts", async () => {
    const firstEnd = await beginNativeVoiceBackground();
    const first = mocks.state.active!;
    await firstEnd();
    const secondEnd = await beginNativeVoiceBackground();
    const second = mocks.state.active!;
    const onStopped = vi.fn();
    const unsubscribe = subscribeNativeVoiceStopped(onStopped);
    await firstEnd();
    mocks.emit(first);
    expect(mocks.state.active).toBe(second);
    expect(onStopped).not.toHaveBeenCalled();
    mocks.emit(second);
    expect(onStopped).toHaveBeenCalledOnce();
    unsubscribe();
    await secondEnd();
  });

  it("cleans up a foreground start that was canceled before its acknowledgement", async () => {
    mocks.native.startVoiceSession.mockImplementationOnce(async () => {});
    await expect(beginNativeVoiceBackground()).rejects.toThrow("has ended");
    expect(mocks.native.stopVoiceSession).toHaveBeenCalledOnce();
  });

  it("requires microphone permission before native service or media capture", async () => {
    mocks.state.granted = false;
    await expect(nativeVoiceMedia.getUserMedia()).rejects.toThrow("permission");
    expect(mocks.native.startVoiceSession).not.toHaveBeenCalled();
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
  });

  it("releases the foreground service when native media creation fails", async () => {
    mocks.getUserMedia.mockRejectedValueOnce(new Error("audio unavailable"));
    await expect(nativeVoiceMedia.getUserMedia()).rejects.toThrow("audio unavailable");
    expect(mocks.state.active).toBeNull();
    expect(mocks.native.stopVoiceSession).toHaveBeenCalledOnce();
  });

  it("stops the service only after the captured stream's final track is released", async () => {
    const stop = vi.fn();
    const track = { enabled: true, stop };
    const release = vi.fn();
    mocks.getUserMedia.mockResolvedValueOnce({
      getTracks: () => [track],
      getAudioTracks: () => [track],
      release,
    });
    const stream = await nativeVoiceMedia.getUserMedia();
    expect(mocks.state.active).not.toBeNull();
    stream.getTracks()[0]!.stop();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.state.active).toBeNull();
  });
});
