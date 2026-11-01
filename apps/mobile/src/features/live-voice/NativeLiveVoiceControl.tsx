import { useAtomMount, useAtomSubscribe } from "@effect/atom-react";
import {
  LiveVoiceController,
  type LiveVoiceLease,
  type LiveVoiceSignalingAdapter,
  type LiveVoiceTarget,
} from "@t3tools/client-runtime/live-voice";
import type { EnvironmentId, LiveVoiceEvent, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { randomUUID } from "expo-crypto";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useId, useMemo } from "react";
import { AppState, Linking, Platform, View } from "react-native";

import { Button } from "../../components/ui/Button";
import {
  liveVoiceEnvironment,
  nativeLiveVoiceSession,
  useNativeLiveVoiceSession,
} from "../../state/liveVoice";
import { useAtomCommand } from "../../state/use-atom-command";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { unwrapLiveVoiceCommand } from "./liveVoiceCommands";
import { createVoiceEventBridge } from "./liveVoiceEvents";
import { nativeVoiceMedia } from "./nativeVoiceMedia";
import { subscribeNativeVoiceStopped } from "./nativeVoiceBackground";
import { GlobalNativeVoiceControls } from "./NativeVoiceConversation";

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
      input: {
        leaseId: props.lease.leaseId,
        generation: props.lease.generation,
        includeActivities: true,
      },
    }),
    [props.environmentId, props.lease.leaseId, props.lease.generation],
  );
  const atom = liveVoiceEnvironment.events(target);
  const forward = useCallback(
    (result: AsyncResult.AsyncResult<LiveVoiceEvent, unknown>) => {
      if (AsyncResult.isSuccess(result)) props.bridge.publish(target.input, result.value);
      else if (AsyncResult.isFailure(result)) props.bridge.publishUnavailable(target.input);
    },
    [props.bridge, target],
  );
  // Subscribe before mounting so a fast status barrier and completion cannot coalesce in React.
  useAtomSubscribe(atom, forward, { immediate: true });
  useAtomMount(atom);
  return null;
}

export function NativeLiveVoiceControl(props: VoiceProps) {
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
  const { state: current, busy } = useNativeLiveVoiceSession();
  // Start availability may refresh on resume; it is not the active call's identity.
  const target = useMemo<LiveVoiceTarget>(
    () => ({
      environmentId: props.environmentId,
      threadId: props.threadId,
      provider: "codex",
      providerInstanceId: props.providerInstanceId,
    }),
    [props.environmentId, props.providerInstanceId, props.threadId],
  );
  const dictation = useGlobalVoiceInput();
  const { onBusyChange } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps dictation disabled while the app-owned call holds the microphone.
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  if (!props.eligible && !busy && !current.error) return null;
  return (
    <View className="gap-2 py-2">
      {!busy && props.eligible ? (
        <Button
          label="Gespräch starten"
          disabled={dictation.isBusy}
          onPress={() => {
            if (AppState.currentState !== "active" || dictation.isBusy) return;
            void nativeLiveVoiceSession.start(target, (onStateChange) => ({
              value: { bridge },
              controller: new LiveVoiceController({
                ...nativeVoiceMedia,
                signaling,
                createRequestId: randomUUID,
                scheduleTimeout: (callback, delay) => {
                  const handle = setTimeout(callback, delay);
                  return () => clearTimeout(handle);
                },
                onStateChange,
              }),
            }));
          }}
        />
      ) : null}
      {current.error ? (
        <View className="gap-2">
          <Button
            label="Microphone settings"
            tone="text"
            onPress={() => {
              void Linking.openSettings();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

export function GlobalNativeLiveVoice(props: {
  readonly onOpenThread: (environmentId: string, threadId: string) => void;
}) {
  const { target, state, busy, value } = useNativeLiveVoiceSession();
  const keepAwakeId = useId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Only app teardown, not navigation, releases the native call.
  useEffect(
    () => () => {
      void nativeLiveVoiceSession.end();
    },
    [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- iOS does not have the Android foreground-call service, so backgrounding must release its microphone.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background" && Platform.OS !== "android") void nativeLiveVoiceSession.end();
    });
    return () => subscription.remove();
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps unsupported-background platforms awake only while the call owns media.
  useEffect(() => {
    if (!busy || Platform.OS === "android") return;
    const tag = `live-voice:${keepAwakeId}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [busy, keepAwakeId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Native notification End releases the same app-owned call.
  useEffect(
    () =>
      subscribeNativeVoiceStopped(() => {
        void nativeLiveVoiceSession.end();
      }),
    [],
  );
  return (
    <>
      {target && value && state.lease && busy ? (
        <EventFeed
          environmentId={target.environmentId as EnvironmentId}
          lease={state.lease}
          bridge={value.bridge}
        />
      ) : null}
      <GlobalNativeVoiceControls onOpenThread={props.onOpenThread} />
    </>
  );
}
