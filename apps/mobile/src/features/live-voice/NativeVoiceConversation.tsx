import type { LiveVoiceController, LiveVoiceState } from "@t3tools/client-runtime/live-voice";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import {
  observeVoiceConversation,
  type ObservedVoiceCall,
} from "@t3tools/client-runtime/live-voice";
import { AppText } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import {
  NativeVoiceBubbleViewToggle,
  useNativeVoiceBubbleView,
} from "./NativeVoiceBubbleViewToggle";
import { NativeVoiceActivityBubbles } from "./NativeVoiceActivityBubbles";
import { Button } from "../../components/ui/Button";

type VoicePresentation = {
  readonly state: LiveVoiceState;
  readonly controller: LiveVoiceController;
  readonly eligible: boolean;
};
const PresentationContext = createContext<VoicePresentation | null>(null);
const RegistrationContext = createContext<((value: VoicePresentation | null) => void) | null>(null);
const ObservedContext = createContext<ReadonlyArray<ObservedVoiceCall>>([]);

export function NativeVoiceConversationProvider({ children }: { readonly children: ReactNode }) {
  const [presentation, setPresentation] = useState<VoicePresentation | null>(null);
  const [observed, setObserved] = useState<ReadonlyArray<ObservedVoiceCall>>([]);
  const register = useCallback((value: VoicePresentation | null) => {
    setPresentation(value);
    if (value) {
      const receivedAt = new Date().toISOString();
      setObserved((previous) => observeVoiceConversation(previous, value.state, receivedAt));
    }
  }, []);
  return (
    <RegistrationContext value={register}>
      <PresentationContext value={presentation}>
        <ObservedContext value={observed}>{children}</ObservedContext>
      </PresentationContext>
    </RegistrationContext>
  );
}

export function useNativeVoicePresentation(value: VoicePresentation) {
  const register = useContext(RegistrationContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the mounted native controller registration used by conversation controls and retains its external call receipts.
  useEffect(() => {
    register?.(value);
    return () => register?.(null);
  }, [register, value]);
}

export const useNativeVoiceObserved = () => useContext(ObservedContext);

const labels: Record<LiveVoiceState["phase"], string> = {
  idle: "Voice",
  preparing: "Vorbereiten…",
  prepared: "Verbinden…",
  connecting: "Verbinden…",
  live: "Verbunden",
  reconnecting: "Verbindung wird wiederhergestellt…",
  "playback-blocked": "Ausgabe pausiert",
  stopping: "Gespräch wird beendet…",
  ended: "Gespräch beendet",
  error: "Verbindung fehlgeschlagen",
};

export function NativeVoiceConversationHeader() {
  const presentation = useContext(PresentationContext);
  const { enabled: bubbles } = useNativeVoiceBubbleView();
  if (
    !presentation ||
    (!presentation.eligible && !presentation.state.lease && !presentation.state.transcript.length)
  )
    return null;
  const { state, controller } = presentation;
  const busy = !["idle", "ended", "error"].includes(state.phase);
  if (!busy && !state.error && !(bubbles && state.activities?.length)) return null;
  const canMute = ["live", "reconnecting", "playback-blocked"].includes(state.phase);
  return (
    <View className="border-b border-border bg-thread-canvas px-3 py-2">
      {busy || state.error ? (
        <View className="min-h-14 flex-row items-center gap-1 pt-1">
          <View className="min-w-0 flex-1 px-1">
            <AppText
              accessibilityLiveRegion="polite"
              className="text-sm font-t3-medium text-foreground"
            >
              {labels[state.phase]}
            </AppText>
            {state.localMuted || state.outputMuted ? (
              <AppText className="text-xs text-foreground-muted">
                {[
                  state.localMuted ? "Mikrofon aus" : null,
                  state.outputMuted ? "Ausgabe aus" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </AppText>
            ) : null}
          </View>
          {busy ? (
            <>
              <IconButton
                icon="mic"
                accessibilityLabel={
                  state.localMuted ? "Mikrofon einschalten" : "Mikrofon stummschalten"
                }
                selected={state.localMuted}
                variant={state.localMuted ? "tonal" : "standard"}
                disabled={!canMute}
                onPress={() => controller.setLocalMuted(!state.localMuted)}
              />
              <IconButton
                icon="headphones"
                accessibilityLabel={
                  state.outputMuted ? "Ausgabe einschalten" : "Ausgabe stummschalten"
                }
                selected={state.outputMuted}
                variant={state.outputMuted ? "tonal" : "standard"}
                disabled={!canMute}
                onPress={() => {
                  void controller.setOutputMuted(!state.outputMuted);
                }}
              />
              <IconButton
                icon="stop.fill"
                variant="danger"
                accessibilityLabel="Gespräch beenden"
                onPress={() => {
                  void controller.end();
                }}
              />
            </>
          ) : null}
        </View>
      ) : null}
      {state.lease && (busy || (state.activities?.length ?? 0) > 0) ? (
        <>
          <NativeVoiceBubbleViewToggle />
          {bubbles ? (
            <NativeVoiceActivityBubbles
              threadRef={state.lease}
              liveActivities={state.activities ?? []}
            />
          ) : null}
        </>
      ) : null}
      {state.phase === "playback-blocked" ? (
        <Button
          label="Ausgabe fortsetzen"
          tone="text"
          onPress={() => {
            void controller.retryPlayback();
          }}
        />
      ) : null}
      {state.error ? (
        <AppText accessibilityRole="alert" className="text-sm text-danger">
          {state.error}
        </AppText>
      ) : null}
    </View>
  );
}
