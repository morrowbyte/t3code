import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";
import { AppTextInput as TextInput } from "../../components/ui/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails } from "../../state/threads";
import {
  ComposerDictationCancelAction,
  ComposerDictationError,
  ComposerDictationPrimaryAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { createQuestionDictationDraft, questionDictationOwnerKey } from "./questionDictationDraft";

export function QuestionAnswerInput(props: {
  readonly origin: ScopedThreadRef;
  readonly requestId: string;
  readonly questionId: string;
  readonly label: string;
  readonly multiline: boolean;
  readonly disabled: boolean;
  readonly dictationDisabled: boolean;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
}) {
  const inputRef = useRef<TextInputInstance>(null);
  const nativeText = useRef(props.value);
  const [initialText] = useState(props.value);
  const ownerKey = questionDictationOwnerKey(props.origin, props.requestId, props.questionId);
  const draft = useMemo(() => createQuestionDictationDraft(ownerKey), [ownerKey]);
  const { session } = useGlobalVoiceInput();
  const disabled = props.disabled || props.dictationDisabled;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the active native dictation target current and cancel its voice session when this input becomes unavailable.
  useLayoutEffect(() => {
    if (disabled) {
      draft.deactivate();
      session.cancel(ownerKey);
    } else draft.update(props.value, props.onChangeText);
  }, [draft, disabled, props.value, props.onChangeText, session, ownerKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Invalidate captured dictation targets and release this owner's native voice session on unmount or owner change.
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
      : { start: props.value.length, end: props.value.length };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only external draft changes replace native text, preserving autocorrection while typing
  useLayoutEffect(() => {
    if (nativeText.current === props.value) return;
    nativeText.current = props.value;
    inputRef.current?.setNativeProps({ text: props.value, selection });
  }, [props.value, selection]);
  const readDraftMessage = () => {
    const request = appAtomRegistry
      .get(environmentThreadDetails.pendingRequestsAtom(props.origin))
      ?.userInputs.find((request) => request.requestId === props.requestId);
    const question = request?.questions.find((question) => question.id === props.questionId);
    if (
      !question ||
      question.allowCustomAnswer === false ||
      request?.responseCapability === "not_resumable"
    )
      return null;
    return draft.read();
  };
  const voice = useVoiceInputController({
    ownerKey: draft.ownerKey,
    environmentId: props.origin.environmentId,
    label: props.label,
    disabled,
    readDraftMessage,
    subscribeToDraftChanges: draft.subscribe,
    selection,
    onChangeDraftMessage: (value) => {
      if (readDraftMessage() !== null) draft.commit(value);
    },
    onChangeSelection: (selection) => setCursor({ ownerKey, selection }),
  });
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel={props.label}
        ref={inputRef}
        defaultValue={initialText}
        multiline={props.multiline}
        submitBehavior={props.multiline ? "newline" : undefined}
        editable={!props.disabled && !voice.freezesEditor}
        onChangeText={(value) => {
          nativeText.current = value;
          // Observe edits before the parent renders the updated draft.
          draft.update(value, props.onChangeText);
          props.onChangeText(value);
        }}
        onSelectionChange={({ nativeEvent }) =>
          setCursor({ ownerKey, selection: nativeEvent.selection })
        }
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        placeholder="Or type a custom answer"
        className="min-h-[54px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
      />
      <ComposerDictationError
        error={voice.state.phase === "error" ? voice.state.error : null}
        onDismiss={voice.cancel}
      />
      {voice.isAvailable || presentation.statusLabel !== null ? (
        <ComposerDictationToolbar showsDictation={presentation.statusLabel !== null}>
          <View className="h-11 flex-row items-center justify-end">
            <ComposerDictationCancelAction presentation={presentation} onCancel={voice.cancel} />
            <ComposerDictationStatus
              audioLevels={voice.audioLevels}
              elapsedSeconds={voice.elapsedSeconds}
              phase={voice.state.phase}
              presentation={presentation}
            />
            <ComposerDictationPrimaryAction
              state={voice.state}
              presentation={presentation}
              isAvailable={voice.isAvailable}
              disabled={disabled}
              onStart={voice.start}
              onConfirm={voice.stop}
              onCancel={voice.cancel}
            />
          </View>
        </ComposerDictationToolbar>
      ) : null}
    </View>
  );
}
