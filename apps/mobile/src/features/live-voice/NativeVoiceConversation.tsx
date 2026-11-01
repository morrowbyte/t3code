import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { FullWindowOverlay } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AppText } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Button } from "../../components/ui/Button";
import { nativeLiveVoiceSession, useNativeLiveVoiceSession } from "../../state/liveVoice";
import { useEnvironmentPresentation } from "../../state/presentation";
import { environmentThreadShells } from "../../state/threads";
import { workspaceDockBottomClearance } from "../workspace/workspace-tabs-state";
import {
  NativeVoiceBubbleViewToggle,
  useNativeVoiceBubbleView,
} from "./NativeVoiceBubbleViewToggle";
import { NativeVoiceActivityBubbles } from "./NativeVoiceActivityBubbles";

export function NativeVoiceConversationProvider({ children }: { readonly children: ReactNode }) {
  return children;
}
export function NativeVoiceConversationHeader() {
  return null;
}
export const useNativeVoiceObserved = () => useNativeLiveVoiceSession().calls;

type OpenThread = (environmentId: string, threadId: string) => void;

export function GlobalNativeVoiceControls(props: { readonly onOpenThread: OpenThread }) {
  const { target, state, controller, busy } = useNativeLiveVoiceSession();
  const insets = useSafeAreaInsets();
  const { enabled: bubbles } = useNativeVoiceBubbleView();
  if (!target || !controller || (!busy && !state.error)) return null;
  const controls = (
    <VoiceControls
      target={target}
      onOpenThread={props.onOpenThread}
      bottom={workspaceDockBottomClearance({ bottomInset: insets.bottom, keyboardHeight: 0 })}
      bubbles={bubbles}
    />
  );
  return Platform.OS === "ios" ? <FullWindowOverlay>{controls}</FullWindowOverlay> : controls;
}

function VoiceControls(props: {
  readonly target: { readonly environmentId: string; readonly threadId: string };
  readonly onOpenThread: OpenThread;
  readonly bottom: number;
  readonly bubbles: boolean;
}) {
  const { target, bottom, onOpenThread, bubbles } = props;
  const { state, controller, busy } = useNativeLiveVoiceSession();
  const threadRef = {
    environmentId: EnvironmentId.make(target.environmentId),
    threadId: ThreadId.make(target.threadId),
  };
  const thread = useAtomValue(environmentThreadShells.threadShellAtom(threadRef));
  const { presentation: environment } = useEnvironmentPresentation(threadRef.environmentId);
  if (!controller) return null;
  const canMute = ["live", "reconnecting", "playback-blocked"].includes(state.phase);
  const label = {
    idle: "Voice",
    preparing: "Vorbereiten…",
    prepared: "Verbinden…",
    connecting: "Verbinden…",
    live: "Verbunden",
    reconnecting: "Neu verbinden…",
    "playback-blocked": "Ausgabe pausiert",
    stopping: "Beenden…",
    ended: "Beendet",
    error: "Verbindung fehlgeschlagen",
  }[state.phase];
  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      <View
        className="absolute left-3 right-3 rounded-xl border border-border bg-card p-2"
        style={{ bottom }}
        accessibilityLabel="Sprachgespräch"
      >
        <View className="flex-row items-center gap-1">
          <Pressable
            className="min-w-0 flex-1 px-2 py-1"
            accessibilityRole="button"
            accessibilityLabel="Zum ursprünglichen Voice-Thread"
            onPress={() => onOpenThread(target.environmentId, target.threadId)}
          >
            <AppText numberOfLines={1} className="text-sm font-t3-medium text-foreground">
              {thread?.title || target.threadId}
            </AppText>
            <AppText numberOfLines={1} className="text-xs text-foreground-muted">
              {environment?.entry.target.label || target.environmentId} · {label}
            </AppText>
          </Pressable>
          <IconButton
            icon="mic"
            accessibilityLabel={
              state.localMuted ? "Mikrofon einschalten" : "Mikrofon stummschalten"
            }
            selected={state.localMuted}
            disabled={!canMute}
            onPress={() => controller.setLocalMuted(!state.localMuted)}
          />
          <IconButton
            icon="headphones"
            accessibilityLabel={state.outputMuted ? "Ausgabe einschalten" : "Ausgabe stummschalten"}
            selected={state.outputMuted}
            disabled={!canMute}
            onPress={() => void controller.setOutputMuted(!state.outputMuted)}
          />
          <IconButton
            icon="stop.fill"
            variant="danger"
            accessibilityLabel="Gespräch beenden"
            disabled={state.phase === "stopping"}
            onPress={() => void nativeLiveVoiceSession.end()}
          />
        </View>
        {state.phase === "playback-blocked" ? (
          <Button
            label="Ausgabe fortsetzen"
            tone="text"
            onPress={() => void controller.retryPlayback()}
          />
        ) : null}
        {state.error ? (
          <AppText accessibilityRole="alert" className="text-sm text-danger">
            {state.error}
          </AppText>
        ) : null}
        {state.lease && busy ? (
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
      </View>
    </View>
  );
}
