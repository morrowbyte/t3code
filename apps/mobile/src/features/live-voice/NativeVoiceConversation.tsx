import type { LiveVoiceController, LiveVoiceState } from "@t3tools/client-runtime/live-voice";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { SymbolView } from "../../components/ui/AppSymbol";

type VoicePresentation = {
  readonly state: LiveVoiceState;
  readonly controller: LiveVoiceController;
  readonly eligible: boolean;
};
type VoiceView = "chat" | "conversation";
const PresentationContext = createContext<VoicePresentation | null>(null);
const RegistrationContext = createContext<((value: VoicePresentation | null) => void) | null>(null);
const ViewContext = createContext<{ view: VoiceView; select: (view: VoiceView) => void }>({
  view: "chat",
  select: () => {},
});

export function NativeVoiceConversationProvider({ children }: { readonly children: ReactNode }) {
  const [presentation, register] = useState<VoicePresentation | null>(null);
  const [view, select] = useState<VoiceView>("chat");
  const selection = useMemo(() => ({ view, select }), [view]);
  return (
    <RegistrationContext value={register}>
      <PresentationContext value={presentation}>
        <ViewContext value={selection}>{children}</ViewContext>
      </PresentationContext>
    </RegistrationContext>
  );
}

export function useNativeVoicePresentation(value: VoicePresentation) {
  const register = useContext(RegistrationContext);
  useEffect(() => {
    register?.(value);
    return () => register?.(null);
  }, [register, value]);
}

export const useNativeVoiceView = () => useContext(ViewContext);

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
  const { view, select } = useNativeVoiceView();
  if (
    !presentation ||
    (!presentation.eligible && !presentation.state.lease && !presentation.state.transcript.length)
  )
    return null;
  const { state, controller } = presentation;
  const busy = !["idle", "ended", "error"].includes(state.phase);
  const canMute = ["live", "reconnecting", "playback-blocked"].includes(state.phase);
  return (
    <View className="border-b border-border bg-thread-canvas px-3 py-2">
      <View accessibilityRole="tablist" className="flex-row rounded-2xl bg-subtle p-1">
        {(["chat", "conversation"] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="tab"
            accessibilityState={{ selected: view === mode }}
            accessibilityLabel={mode === "chat" ? "Chat" : "Gespräch"}
            onPress={() => select(mode)}
            className={`min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl ${view === mode ? "bg-primary" : ""}`}
          >
            <SymbolView
              name={mode === "chat" ? "text.bubble" : "mic"}
              size={18}
              tintColorClassName={view === mode ? "accent-primary-foreground" : "accent-foreground"}
            />
            <AppText
              className={`text-sm font-t3-medium ${view === mode ? "text-primary-foreground" : "text-foreground"}`}
            >
              {mode === "chat" ? "Chat" : "Gespräch"}
            </AppText>
          </Pressable>
        ))}
      </View>
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

export function NativeVoiceConversationTranscript() {
  const presentation = useContext(PresentationContext);
  const [expanded, setExpanded] = useState(false);
  const latest = presentation?.state.transcript.at(-1);
  if (!presentation || !latest) return null;
  return (
    <View
      className="border-b border-border bg-thread-canvas px-5 pb-3"
      testID="voice-conversation-transcript"
    >
      <View className="min-h-11 flex-row items-center justify-between">
        <AppText className="text-xs font-t3-medium text-foreground-muted">
          {latest.speaker === "user" ? "Du · Voice" : "Voice"}
          {latest.final ? "" : "…"}
        </AppText>
        <Button label="Mitschrift" tone="text" onPress={() => setExpanded(true)} />
      </View>
      <AppText selectable numberOfLines={3} className="text-lg leading-7 text-foreground">
        {latest.text}
      </AppText>
      {expanded ? (
        <Sheet title="Mitschrift" onClose={() => setExpanded(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            className="flex-1"
            contentContainerStyle={{ padding: 20, gap: 20 }}
          >
            {presentation.state.transcript.map((entry, index) => (
              <View key={entry.segmentId ?? index} className="gap-2">
                <AppText className="text-xs font-t3-medium text-foreground-muted">
                  {entry.speaker === "user" ? "Du · Voice" : "Voice"}
                  {entry.final ? "" : "…"}
                </AppText>
                <AppText selectable className="text-base leading-6 text-foreground">
                  {entry.text}
                </AppText>
              </View>
            ))}
          </ScrollView>
        </Sheet>
      ) : null}
    </View>
  );
}
