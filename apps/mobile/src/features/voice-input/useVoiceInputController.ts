import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import type { EnvironmentId, SpeechTranscriptionRange } from "@t3tools/contracts";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";
import { environmentVoiceTranscriber } from "./environmentVoiceTranscriber";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onCommitSpeechTranscription?: (
    value: string,
    insertion: SpeechTranscriptionRange,
    replacement: SpeechTranscriptionRange,
  ) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const global = useGlobalVoiceInput();
  const [remoteError, setRemoteError] = useState<{ ownerKey: string; message: string } | null>(
    null,
  );
  const { setOwnerFocused, session } = global;
  const latestInput = useRef(input);
  latestInput.current = input;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      setOwnerFocused(ownerKey, true);
      return () => setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, setOwnerFocused]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return;
    const ownerKey = captured.ownerKey;
    setRemoteError(null);
    void session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          if (captured.onCommitSpeechTranscription) {
            const previous = captured.readDraftMessage();
            if (previous === null) return;
            const start = Math.max(
              0,
              Math.min(previous.length, Math.trunc(captured.selection.start)),
            );
            const end = Math.max(
              start,
              Math.min(previous.length, Math.trunc(captured.selection.end)),
            );
            captured.onCommitSpeechTranscription(
              text,
              { start, end: Math.trunc(selection.start) },
              { start, end },
            );
          } else captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
      ...(Platform.OS === "android"
        ? {
            transcriber: captured.environmentId
              ? environmentVoiceTranscriber(captured.environmentId, (message) => {
                  if (
                    mounted.current &&
                    latestInput.current.ownerKey === ownerKey &&
                    latestInput.current.environmentId === captured.environmentId
                  ) {
                    setRemoteError({ ownerKey, message });
                  }
                })
              : null,
          }
        : {}),
    });
  }, [session]);
  const baseState = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const state =
    baseState.phase === "error" && remoteError?.ownerKey === input.ownerKey
      ? { ...baseState, error: remoteError.message }
      : baseState;
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable:
      global.isAvailable &&
      !input.disabled &&
      (Platform.OS !== "android" || input.environmentId !== null) &&
      (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
