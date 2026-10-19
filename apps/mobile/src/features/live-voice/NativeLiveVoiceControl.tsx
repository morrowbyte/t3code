import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  LiveVoiceController,
  type LiveVoiceLease,
  type LiveVoiceSignalingAdapter,
  type LiveVoiceState,
  type LiveVoiceTarget,
} from "@t3tools/client-runtime/live-voice";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { randomUUID } from "expo-crypto";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Platform, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { liveVoiceEnvironment } from "../../state/liveVoice";
import { useAtomCommand } from "../../state/use-atom-command";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { unwrapLiveVoiceCommand } from "./liveVoiceCommands";
import { createVoiceEventBridge } from "./liveVoiceEvents";
import { nativeVoiceMedia } from "./nativeVoiceMedia";
import { subscribeNativeVoiceStopped } from "./nativeVoiceBackground";
import { VoiceTranscript } from "./VoiceTranscript";

type VoiceProps = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: string;
  readonly eligible: boolean;
  readonly onBusyChange: (busy: boolean) => void;
};

function EventFeed(props: {
  readonly environmentId: EnvironmentId;
  readonly lease: LiveVoiceLease;
  readonly bridge: ReturnType<typeof createVoiceEventBridge>;
}) {
  const target = useMemo(
    () => ({
      environmentId: props.environmentId,
      input: { leaseId: props.lease.leaseId, generation: props.lease.generation },
    }),
    [props.environmentId, props.lease.leaseId, props.lease.generation],
  );
  const result = useAtomValue(liveVoiceEnvironment.events(target));
  useEffect(() => {
    if (AsyncResult.isSuccess(result)) props.bridge.publish(target.input, result.value);
    else if (AsyncResult.isFailure(result)) props.bridge.publishUnavailable(target.input);
  }, [props.bridge, result, target]);
  return null;
}

const phaseLabel: Record<LiveVoiceState["phase"], string | null> = {
  idle: null,
  ended: null,
  error: null,
  preparing: "Preparing voice…",
  prepared: "Connecting…",
  connecting: "Connecting…",
  live: "Voice connected",
  reconnecting: "Reconnecting…",
  stopping: "Ending call…",
  "playback-blocked": "Audio paused",
};

export function NativeLiveVoiceControl(props: VoiceProps) {
  return (
    <LiveVoiceSession
      key={`${props.environmentId}:${props.threadId}:${props.providerInstanceId}`}
      {...props}
    />
  );
}

function LiveVoiceSession(props: VoiceProps) {
  const prepare = useAtomCommand(liveVoiceEnvironment.prepare, {
    reportFailure: false,
    reportDefect: false,
  });
  const start = useAtomCommand(liveVoiceEnvironment.start, {
    reportFailure: false,
    reportDefect: false,
  });
  const stop = useAtomCommand(liveVoiceEnvironment.stop, {
    reportFailure: false,
    reportDefect: false,
  });
  const status = useAtomCommand(liveVoiceEnvironment.status, {
    reportFailure: false,
    reportDefect: false,
  });
  const bridge = useMemo(() => createVoiceEventBridge(), []);
  const signaling = useMemo<LiveVoiceSignalingAdapter>(
    () => ({
      subscribe: bridge.subscribe,
      prepare: async (input) =>
        unwrapLiveVoiceCommand(await prepare({ environmentId: props.environmentId, input })),
      start: async (input) =>
        unwrapLiveVoiceCommand(await start({ environmentId: props.environmentId, input })),
      stop: async (input) =>
        unwrapLiveVoiceCommand(await stop({ environmentId: props.environmentId, input })),
      status: async (input) =>
        unwrapLiveVoiceCommand(await status({ environmentId: props.environmentId, input })),
    }),
    [bridge, prepare, props.environmentId, start, stop, status],
  );
  const activeController = useRef<LiveVoiceController | null>(null);
  const [observed, setObserved] = useState<{
    controller: LiveVoiceController;
    state: LiveVoiceState;
  } | null>(null);
  const controller = useMemo(() => {
    const instance = new LiveVoiceController({
      ...nativeVoiceMedia,
      signaling,
      createRequestId: randomUUID,
      scheduleTimeout: (callback, delay) => {
        const handle = setTimeout(callback, delay);
        return () => clearTimeout(handle);
      },
      onStateChange: (next) => {
        if (activeController.current === instance)
          setObserved({ controller: instance, state: next });
      },
    });
    return instance;
  }, [signaling]);
  const current = observed?.controller === controller ? observed.state : controller.currentState;
  const busy = !["idle", "ended", "error"].includes(current.phase);
  const canMute = ["live", "reconnecting", "playback-blocked"].includes(current.phase);
  const target = useMemo<LiveVoiceTarget | null>(
    () =>
      props.eligible
        ? {
            environmentId: props.environmentId,
            threadId: props.threadId,
            provider: "codex",
            providerInstanceId: props.providerInstanceId,
          }
        : null,
    [props.eligible, props.environmentId, props.providerInstanceId, props.threadId],
  );
  const focused = useRef(false);
  const dictation = useGlobalVoiceInput();
  const [showTranscript, setShowTranscript] = useState(false);
  const keepAwakeId = useId();
  const { onBusyChange } = props;

  useLayoutEffect(() => {
    activeController.current = controller;
    return () => {
      if (activeController.current === controller) activeController.current = null;
      void controller.end();
    };
  }, [controller]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    void controller.contextChanged(target);
  }, [controller, target]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        void controller.end();
      };
    }, [controller]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background" && Platform.OS !== "android") void controller.end();
    });
    return () => subscription.remove();
  }, [controller]);
  useEffect(() => {
    if (!busy || Platform.OS === "android") return;
    const tag = `live-voice:${keepAwakeId}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [busy, keepAwakeId]);

  useEffect(
    () =>
      subscribeNativeVoiceStopped(() => {
        void controller.end();
      }),
    [controller],
  );

  if (!props.eligible && !busy && !current.error) return null;
  return (
    <View className="gap-2 py-2">
      {current.lease ? (
        <EventFeed environmentId={props.environmentId} lease={current.lease} bridge={bridge} />
      ) : null}
      <View className="flex-row flex-wrap items-center gap-2">
        {busy ? (
          <>
            <Button
              label={current.localMuted ? "Unmute mic" : "Mute mic"}
              disabled={!canMute}
              onPress={() => controller.setLocalMuted(!current.localMuted)}
            />
            <Button
              label={current.outputMuted ? "Unmute audio" : "Mute audio"}
              disabled={!canMute}
              onPress={() => {
                void controller.setOutputMuted(!current.outputMuted);
              }}
            />
            <Button
              label="End call"
              tone="danger"
              onPress={() => {
                void controller.end();
              }}
            />
          </>
        ) : (
          <Button
            label="Voice chat"
            disabled={!target || dictation.isBusy}
            onPress={() => {
              if (target && focused.current && AppState.currentState === "active")
                void controller.start(target);
            }}
          />
        )}
        {current.phase === "playback-blocked" ? (
          <Button
            label="Resume audio"
            onPress={() => {
              void controller.retryPlayback();
            }}
          />
        ) : null}
        {current.transcript.length ? (
          <Button
            label={showTranscript ? "Hide transcript" : "Transcript"}
            tone="text"
            onPress={() => setShowTranscript((value) => !value)}
          />
        ) : null}
      </View>
      {phaseLabel[current.phase] ? (
        <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {phaseLabel[current.phase]}
        </AppText>
      ) : null}
      {current.error ? (
        <View className="gap-2">
          <AppText accessibilityRole="alert" className="text-sm text-danger">
            {current.error}
          </AppText>
          <Button
            label="Microphone settings"
            tone="text"
            onPress={() => {
              void Linking.openSettings();
            }}
          />
        </View>
      ) : null}
      {showTranscript && current.transcript.length ? (
        <VoiceTranscript entries={current.transcript} />
      ) : null}
    </View>
  );
}
