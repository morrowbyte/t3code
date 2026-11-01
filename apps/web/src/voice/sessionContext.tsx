import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { LiveVoiceSessionOwner } from "@t3tools/client-runtime/live-voice";
import type { LiveVoiceRecording, CallRecordingState } from "./LiveVoiceRecording";
import type { createVoiceEventBridge } from "./LiveVoiceControl";

type Binding = {
  readonly bridge: ReturnType<typeof createVoiceEventBridge>;
  readonly recording: LiveVoiceRecording;
};
const SessionContext = createContext<{
  readonly owner: LiveVoiceSessionOwner<Binding>;
  readonly recordingState: CallRecordingState;
  readonly setRecordingState: (state: CallRecordingState) => void;
  readonly controlsContainer: HTMLDivElement | null;
  readonly setControlsContainer: (container: HTMLDivElement | null) => void;
} | null>(null);

export function WebLiveVoiceSessionProvider({ children }: { readonly children: ReactNode }) {
  const [owner] = useState(() => new LiveVoiceSessionOwner<Binding>());
  const [recordingState, setRecordingState] = useState<CallRecordingState>({ status: "off" });
  const [controlsContainer, setControlsContainer] = useState<HTMLDivElement | null>(null);
  return (
    <SessionContext
      value={{ owner, recordingState, setRecordingState, controlsContainer, setControlsContainer }}
    >
      {children}
    </SessionContext>
  );
}

export function useWebLiveVoiceControlsHost() {
  return useContext(SessionContext)?.setControlsContainer;
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
