import { useState } from "react";
import { CopyIcon } from "lucide-react";
import type { LiveVoiceState } from "@t3tools/client-runtime/live-voice";

import {
  Dialog,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

type LiveVoiceTranscriptEntry = LiveVoiceState["transcript"][number] & {
  readonly occurredAt?: string;
};

function transcriptText(transcript: ReadonlyArray<LiveVoiceTranscriptEntry>): string {
  return transcript
    .map((entry) => `${entry.speaker === "user" ? "You" : "Live"}:\n${entry.text}`)
    .join("\n\n");
}

export function LiveVoiceTranscript(props: {
  readonly transcript: ReadonlyArray<LiveVoiceTranscriptEntry>;
}) {
  const [open, setOpen] = useState(false);
  if (props.transcript.length === 0) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" size="xs" variant="ghost" />}>
        Transcript
      </DialogTrigger>
      <DialogPopup className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Live transcript</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-6 pb-4">
          <LiveVoiceTranscriptContent transcript={props.transcript} />
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export function LiveVoiceTranscriptContent(props: {
  readonly transcript: ReadonlyArray<LiveVoiceTranscriptEntry>;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const copyTranscript = async () => {
    setCopyStatus("copying");
    try {
      const copied = await writeTextToClipboard(
        transcriptText(props.transcript),
        "Live transcript",
      );
      setCopyStatus(copied ? "copied" : "error");
    } catch {
      setCopyStatus("error");
    }
  };
  return (
    <>
      <div
        role="region"
        aria-label="Live conversation transcript"
        tabIndex={0}
        className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ol className="space-y-4">
          {props.transcript.map((entry, index) => (
            <li key={entry.segmentId ?? `${index}-${entry.speaker}`} className="space-y-1">
              <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span>{entry.speaker === "user" ? "You" : "Live"}</span>
                {entry.occurredAt && (
                  <time
                    dateTime={entry.occurredAt}
                    aria-label="Transcript event time"
                    className="font-normal tabular-nums"
                  >
                    {new Date(entry.occurredAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                )}
              </p>
              <p className="select-text whitespace-pre-wrap break-words text-sm">{entry.text}</p>
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {copyStatus !== "idle" && (
          <span
            role={copyStatus === "error" ? "alert" : "status"}
            aria-live={copyStatus === "error" ? "assertive" : "polite"}
            className="text-xs"
          >
            {copyStatus === "copied"
              ? "Transcript copied."
              : copyStatus === "error"
                ? "Couldn’t copy transcript. Try again."
                : "Copying transcript…"}
          </span>
        )}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={copyStatus === "copying"}
          onClick={() => void copyTranscript()}
        >
          <CopyIcon />
          {copyStatus === "copied" ? "Copied" : "Copy transcript"}
        </Button>
      </div>
    </>
  );
}
