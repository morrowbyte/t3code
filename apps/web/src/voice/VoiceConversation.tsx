import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  observeVoiceConversation,
  type LiveVoiceState,
  type ObservedVoiceCall,
} from "@t3tools/client-runtime/live-voice";

const ConversationContext = createContext<ReadonlyArray<ObservedVoiceCall>>([]);
const RegistrationContext = createContext<((state: LiveVoiceState) => void) | null>(null);

export function VoiceConversationProvider({ children }: { readonly children: ReactNode }) {
  const [calls, setCalls] = useState<ReadonlyArray<ObservedVoiceCall>>([]);
  const register = (state: LiveVoiceState) => {
    const receivedAt = new Date().toISOString();
    setCalls((previous) => observeVoiceConversation(previous, state, receivedAt));
  };
  return (
    <RegistrationContext value={register}>
      <ConversationContext value={calls}>{children}</ConversationContext>
    </RegistrationContext>
  );
}

export function useVoiceConversationPresentation(state: LiveVoiceState) {
  const register = useContext(RegistrationContext);
  useEffect(() => {
    register?.(state);
  }, [register, state]);
}

export function useObservedVoiceConversation(environmentId: string, threadId: string) {
  const calls = useContext(ConversationContext);
  return calls.filter(
    ({ call, environmentId: callEnvironmentId }) =>
      // The provider is keyed to the route, and these receipts also guard a
      // draft becoming a server thread while its controller is still mounted.
      call.threadId === threadId && callEnvironmentId === environmentId,
  );
}
