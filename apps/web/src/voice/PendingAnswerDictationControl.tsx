import type { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";
import { VoiceDictationControl } from "./VoiceDictationControl";
import { transcribeVoiceRecording } from "./transcriptionClient";
import type { VoiceDictationTranscriber } from "./useVoiceDictation";

export function PendingAnswerDictationControl(props: {
  environmentId: EnvironmentId;
  scope: string;
  requestId: string;
  questionId: string;
  answer: string;
  onChangeAnswer: (answer: string) => void;
  onInserted?: () => void;
  transcribe?: VoiceDictationTranscriber;
}) {
  const targetKey = JSON.stringify([
    props.scope,
    props.environmentId,
    props.requestId,
    props.questionId,
  ]);
  const current = useRef({ targetKey, answer: props.answer });
  useLayoutEffect(() => {
    current.current = { targetKey, answer: props.answer };
  });
  return (
    <VoiceDictationControl
      environmentId={props.environmentId}
      targetKey={targetKey}
      currentTargetKey={() => current.current.targetKey}
      transcribe={props.transcribe ?? transcribeVoiceRecording(props.environmentId)}
      hasTranscript={(text) => current.current.answer.includes(text)}
      onTranscript={(text, recordedTarget) => {
        if (recordedTarget !== current.current.targetKey || !text.trim()) return false;
        const answer = current.current.answer;
        const next = `${answer}${answer && !/\s$/u.test(answer) ? " " : ""}${text}`;
        current.current.answer = next;
        props.onChangeAnswer(next);
        props.onInserted?.();
        return true;
      }}
    />
  );
}
