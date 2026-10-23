import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

export function questionDictationBlocksSubmission(
  origin: ScopedThreadRef | null,
  requestId: string,
  ownerKey: string | null,
  state: VoiceInputState,
) {
  return (
    origin !== null &&
    ownerKey?.startsWith(questionDictationRequestKey(origin, requestId)) === true &&
    voiceInputBlocksSubmission(state)
  );
}

export function questionDictationRequestKey(origin: ScopedThreadRef, requestId: string) {
  return `question-dictation:${JSON.stringify([origin.environmentId, origin.threadId, requestId])}:`;
}

export function questionDictationOwnerKey(
  origin: ScopedThreadRef,
  requestId: string,
  questionId: string,
) {
  return `${questionDictationRequestKey(origin, requestId)}${JSON.stringify(questionId)}`;
}

// A question can disappear while permission or transcription is still pending.
// Keep captured voice targets invalid after their input leaves, even if its IDs return.
export function createQuestionDictationDraft(ownerKey: string) {
  let current: { value: string; onChange: (value: string) => void } | null = null;
  const listeners = new Set<() => void>();
  return {
    ownerKey,
    update(value: string, onChange: (value: string) => void) {
      const changed = current?.value !== value;
      current = { value, onChange };
      if (changed) listeners.forEach((listener) => listener());
    },
    deactivate() {
      current = null;
      listeners.forEach((listener) => listener());
    },
    read: () => current?.value ?? null,
    commit(value: string) {
      current?.onChange(value);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
