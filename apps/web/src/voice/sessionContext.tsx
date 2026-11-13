import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { LiveVoiceSessionOwner } from "@t3tools/client-runtime/live-voice";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { LiveVoiceRecording, CallRecordingState } from "./LiveVoiceRecording";
import type { createVoiceEventBridge } from "./LiveVoiceControl";
import { useStableCallback } from "../hooks/useStableCallback";
import { BrowserVoiceAudio } from "./BrowserVoiceAudio";

type Binding = {
  readonly bridge: ReturnType<typeof createVoiceEventBridge>;
  readonly recording: LiveVoiceRecording;
};
type ControlsHost = {
  readonly element: HTMLDivElement;
  readonly threadRef?: ScopedThreadRef;
};
const SessionContext = createContext<{
  readonly owner: LiveVoiceSessionOwner<Binding>;
  readonly audio: BrowserVoiceAudio;
  readonly recordingState: CallRecordingState;
  readonly setRecordingState: (state: CallRecordingState) => void;
  readonly controlsContainer: HTMLDivElement | null;
  readonly registerControlsHost: (host: ControlsHost) => () => void;
} | null>(null);

export function WebLiveVoiceSessionProvider({ children }: { readonly children: ReactNode }) {
  const [owner] = useState(() => new LiveVoiceSessionOwner<Binding>());
  const [audio] = useState(() => new BrowserVoiceAudio());
  const [recordingState, setRecordingState] = useState<CallRecordingState>({ status: "off" });
  const [hosts, setHosts] = useState<ReadonlyArray<ControlsHost>>([]);
  const { target } = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const registerControlsHost = useStableCallback((host: ControlsHost) => {
    setHosts((previous) => [...previous, host]);
    return () => setHosts((previous) => previous.filter((entry) => entry !== host));
  });
  const controlsContainer =
    hosts.findLast((host) => !host.threadRef)?.element ??
    hosts.findLast(
      (host) =>
        host.threadRef?.environmentId === target?.environmentId &&
        host.threadRef?.threadId === target?.threadId,
    )?.element ??
    null;
  return (
    <SessionContext
      value={{
        owner,
        audio,
        recordingState,
        setRecordingState,
        controlsContainer,
        registerControlsHost,
      }}
    >
      {children}
    </SessionContext>
  );
}

export function useWebLiveVoiceControlsHost(threadRef?: ScopedThreadRef, enabled = true) {
  const register = useContext(SessionContext)?.registerControlsHost;
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  return (element: HTMLDivElement | null) => {
    if (!element || !register || !enabled) return;
    return register({
      element,
      ...(environmentId && threadId ? { threadRef: { environmentId, threadId } } : {}),
    });
  };
}

const emptySession = new LiveVoiceSessionOwner<Binding>();

export function useOptionalWebLiveVoiceSession() {
  const context = useContext(SessionContext);
  const owner = context?.owner ?? emptySession;
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return context ? { ...context, ...snapshot } : null;
}

export function useWebLiveVoiceSession() {
  const session = useOptionalWebLiveVoiceSession();
  if (!session) throw new Error("Live voice needs the app session provider.");
  return session;
}
