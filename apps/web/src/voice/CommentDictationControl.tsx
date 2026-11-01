import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import type { useCommentDictation } from "./useCommentDictation";

export function CommentDictationControl({
  dictation,
}: {
  readonly dictation: ReturnType<typeof useCommentDictation>;
}) {
  const { state } = dictation;
  if (!dictation.isAvailable) return null;
  const retry = state.phase === "review" || (state.phase === "error" && state.audioUrl);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {dictation.isBusy ? (
        <span role="status" className="text-xs text-muted-foreground">
          {dictation.preparing
            ? "Preparing microphone…"
            : state.phase === "recording"
              ? "Recording"
              : "Transcribing…"}
        </span>
      ) : null}
      {state.phase === "recording" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Finish dictation"
          title="Finish dictation"
          onClick={() => dictation.stop("insert")}
        >
          <SquareIcon />
        </Button>
      ) : !dictation.isBusy ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={retry ? "Retry transcription" : "Dictate comment"}
          title={retry ? "Retry transcription" : "Dictate comment"}
          onClick={() => void (retry ? dictation.transcribe("insert") : dictation.start())}
        >
          <MicIcon />
        </Button>
      ) : null}
      {dictation.isBusy || retry || state.phase === "error" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel dictation"
          title="Cancel dictation"
          onClick={dictation.cancel}
        >
          <XIcon />
        </Button>
      ) : null}
      {state.phase === "error" ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
