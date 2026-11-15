import type { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { transcribeVoiceRecording } from "./transcriptionClient";
import { useVoiceDictation, VoiceDictationServiceError } from "./useVoiceDictation";

export function useCommentDictation(input: {
  readonly environmentId: EnvironmentId | null;
  readonly targetKey: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const current = useRef(input);
  const active = useRef<{ targetKey: string; environmentId: EnvironmentId | null } | null>(null);
  const generation = useRef(0);
  const preparingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Async transcription appends to the latest committed draft instead of the text captured at recording start.
  useLayoutEffect(() => {
    current.current = input;
  });
  const dictation = useVoiceDictation({
    // Comments are transient editors; closing one discards its audio, never another draft's.
    transcribe: input.environmentId ? transcribeVoiceRecording(input.environmentId) : null,
    onTranscript: (text) => {
      if (
        !active.current ||
        active.current.targetKey !== current.current.targetKey ||
        active.current.environmentId !== current.current.environmentId ||
        current.current.disabled ||
        !text.trim()
      ) {
        throw VoiceDictationServiceError.new("This comment is no longer available.");
      }
      const value = current.current.value;
      const next = `${value}${value && !/\s$/u.test(value) ? " " : ""}${text}`;
      current.current = { ...current.current, value: next };
      current.current.onChange(next);
    },
  });
  const cancel = useStableCallback(() => {
    generation.current += 1;
    preparingRef.current = false;
    setPreparing(false);
    dictation.cancel();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancels microphone permission and transcription when this editor's target closes or changes.
  useLayoutEffect(() => {
    active.current = input.disabled
      ? null
      : { targetKey: input.targetKey, environmentId: input.environmentId };
    return () => {
      active.current = null;
      cancel();
    };
  }, [input.targetKey, input.environmentId, input.disabled, cancel]);
  const start = async () => {
    if (!active.current || !current.current.environmentId || preparingRef.current) return;
    const attempt = ++generation.current;
    preparingRef.current = true;
    setPreparing(true);
    await dictation.start();
    if (generation.current === attempt) {
      preparingRef.current = false;
      setPreparing(false);
    }
  };
  const isBusy =
    preparing || dictation.state.phase === "recording" || dictation.state.phase === "transcribing";
  return {
    ...dictation,
    cancel,
    start,
    preparing,
    isBusy,
    blocksSubmission: () =>
      preparingRef.current ||
      dictation.state.phase === "recording" ||
      dictation.state.phase === "transcribing",
    isAvailable: input.environmentId !== null && !input.disabled,
  };
}
