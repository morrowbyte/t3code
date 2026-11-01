import type { EnvironmentId } from "@t3tools/contracts";
import { useId, useLayoutEffect, useMemo, useState } from "react";
import { createCommentDictationDraft } from "./commentDictationDraft";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { useVoiceInputController } from "./useVoiceInputController";

export function useCommentDictation(input: {
  readonly environmentId: EnvironmentId | null;
  readonly targetKey: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly label: string;
}) {
  const instanceId = useId();
  const ownerKey = `comment:${JSON.stringify([input.environmentId, input.targetKey, instanceId])}`;
  const draft = useMemo(() => createCommentDictationDraft(ownerKey), [ownerKey]);
  const { session } = useGlobalVoiceInput();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the global voice session bound to the mounted comment's current draft.
  useLayoutEffect(() => {
    if (input.disabled) {
      draft.deactivate();
      session.cancel(ownerKey);
    } else draft.update(input.value, input.onChange);
  }, [draft, input.disabled, input.value, input.onChange, session, ownerKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Invalidates the captured target and cancels only its microphone session on close or target change.
  useLayoutEffect(
    () => () => {
      draft.deactivate();
      session.cancel(ownerKey);
    },
    [draft, session, ownerKey],
  );
  const [cursor, setCursor] = useState<{
    ownerKey: string;
    selection: { start: number; end: number };
  } | null>(null);
  const selection =
    cursor?.ownerKey === ownerKey
      ? cursor.selection
      : { start: input.value.length, end: input.value.length };
  const voice = useVoiceInputController({
    ownerKey,
    environmentId: input.environmentId,
    label: input.label,
    disabled: input.disabled,
    readDraftMessage: draft.read,
    subscribeToDraftChanges: draft.subscribe,
    selection,
    onChangeDraftMessage: draft.commit,
    onChangeSelection: (selection) => setCursor({ ownerKey, selection }),
  });
  return {
    ...voice,
    cancel: () => session.cancel(ownerKey),
    selection,
    onSelectionChange: (selection: { start: number; end: number }) =>
      setCursor({ ownerKey, selection }),
    onChangeText: (value: string) => {
      draft.update(value, input.onChange);
      input.onChange(value);
    },
  };
}
