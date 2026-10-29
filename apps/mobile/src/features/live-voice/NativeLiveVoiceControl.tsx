import { useAtomMount, useAtomSubscribe } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  LiveVoiceController,
  type LiveVoiceLease,
  type LiveVoiceSignalingAdapter,
  type LiveVoiceState,
  type LiveVoiceTarget,
} from "@t3tools/client-runtime/live-voice";
import type { EnvironmentId, LiveVoiceEvent, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { randomUUID } from "expo-crypto";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Platform, View } from "react-native";

import { Button } from "../../components/ui/Button";
import { liveVoiceEnvironment } from "../../state/liveVoice";
import { useAtomCommand } from "../../state/use-atom-command";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { unwrapLiveVoiceCommand } from "./liveVoiceCommands";
import { createVoiceEventBridge } from "./liveVoiceEvents";
import { nativeVoiceMedia } from "./nativeVoiceMedia";
import { subscribeNativeVoiceStopped } from "./nativeVoiceBackground";
import { useNativeVoicePresentation } from "./NativeVoiceConversation";

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
  const focused = useRef(false);
  const dictation = useGlobalVoiceInput();
  const presentation = useMemo(
    () => ({ state: current, controller, eligible: props.eligible }),
    [current, controller, props.eligible],
  );
  useNativeVoicePresentation(presentation);
  const keepAwakeId = useId();
  const { onBusyChange } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the native media controller and ends its microphone session when the binding unmounts.
  useLayoutEffect(() => {
    activeController.current = controller;
    return () => {
      if (activeController.current === controller) activeController.current = null;
      void controller.end();
    };
  }, [controller]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Holds the native dictation activity gate while the live controller owns microphone capture.
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Binds the external native voice transport to the committed environment and thread target.
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Listens for native background transitions so unsupported background calls release media resources.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background" && Platform.OS !== "android") void controller.end();
    });
    return () => subscription.remove();
  }, [controller]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Holds the platform keep-awake tag for an active voice call and releases it after activation settles.
  useEffect(() => {
    if (!busy || Platform.OS === "android") return;
    const tag = `live-voice:${keepAwakeId}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [busy, keepAwakeId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes the active controller to native call-stop notifications until unmount.
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
      {!busy && props.eligible ? (
        <Button
          label="Gespräch starten"
          disabled={dictation.isBusy}
          onPress={() => {
            if (focused.current && AppState.currentState === "active") {
              void controller.start(target);
            }
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
