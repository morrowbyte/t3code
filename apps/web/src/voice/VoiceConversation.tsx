import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  observeVoiceConversation,
  type LiveVoiceState,
  type ObservedVoiceCall,
} from "@t3tools/client-runtime/live-voice";

import { useOptionalWebLiveVoiceSession } from "./sessionContext";
import { useStableCallback } from "../hooks/useStableCallback";

const ConversationContext = createContext<ReadonlyArray<ObservedVoiceCall>>([]);
const RegistrationContext = createContext<((state: LiveVoiceState) => void) | null>(null);

export function VoiceConversationProvider({ children }: { readonly children: ReactNode }) {
  const [calls, setCalls] = useState<ReadonlyArray<ObservedVoiceCall>>([]);
  const register = useStableCallback((state: LiveVoiceState) => {
    const receivedAt = new Date().toISOString();
    setCalls((previous) => observeVoiceConversation(previous, state, receivedAt));
  });
  return (
    <RegistrationContext value={register}>
      <ConversationContext value={calls}>{children}</ConversationContext>
    </RegistrationContext>
  );
}

export function useVoiceConversationPresentation(state: LiveVoiceState) {
  const register = useContext(RegistrationContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retains committed voice-controller receipts in the route's call history after the external session ends.
  useEffect(() => {
    register?.(state);
  }, [register, state]);
}

export function useObservedVoiceConversation(environmentId: string, threadId: string) {
  const localCalls = useContext(ConversationContext);
  const calls = useOptionalWebLiveVoiceSession()?.calls ?? localCalls;
  return calls.filter(
    ({ call, environmentId: callEnvironmentId }) =>
      call.threadId === threadId && callEnvironmentId === environmentId,
  );
}
