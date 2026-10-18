import type { SpeechTranscriptionRange } from "@t3tools/contracts";

/** Move known transcription spans through an editor change; never infer speech from words. */
export function editSpeechTranscriptionRanges(
  previous: string,
  next: string,
  ranges: ReadonlyArray<SpeechTranscriptionRange> = [],
  replacement?: SpeechTranscriptionRange,
): SpeechTranscriptionRange[] {
  let start = 0;
  let end = previous.length;
  let nextEnd = next.length;
  if (
    replacement &&
    replacement.start >= 0 &&
    replacement.end >= replacement.start &&
    replacement.end <= previous.length &&
    next.startsWith(previous.slice(0, replacement.start)) &&
    next.endsWith(previous.slice(replacement.end)) &&
    next.length >= previous.length - (replacement.end - replacement.start)
  ) {
    start = replacement.start;
    end = replacement.end;
    nextEnd = next.length - (previous.length - end);
  } else {
    while (start < end && start < nextEnd && previous[start] === next[start]) start += 1;
    while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
      end -= 1;
      nextEnd -= 1;
    }
  }
  const delta = nextEnd - end;
  return ranges.flatMap((range) => {
    const retained: SpeechTranscriptionRange[] = [];
    if (range.start < start) retained.push({ start: range.start, end: Math.min(range.end, start) });
    if (range.end > end)
      retained.push({ start: Math.max(range.start, end) + delta, end: range.end + delta });
    return retained.filter(
      (part) =>
        part.start < part.end &&
        part.end <= next.length &&
        next.slice(part.start, part.end).trim().length > 0,
    );
  });
}

export function hasSpeechTranscription(
  text: string,
  ranges: ReadonlyArray<SpeechTranscriptionRange> = [],
): boolean {
  return ranges.some(
    (range) =>
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.end <= text.length &&
      range.start < range.end &&
      text.slice(range.start, range.end).trim().length > 0,
  );
}

export function speechTranscriptionContext(
  message:
    | {
        readonly messageId: string;
        readonly containsSpeechTranscription?: true | undefined;
        readonly createdBy: string;
        readonly senderThreadId?: string | undefined;
      }
    | undefined,
): string | undefined {
  if (
    message?.containsSpeechTranscription !== true ||
    message.createdBy !== "user" ||
    message.senderThreadId !== undefined
  )
    return undefined;
  const id = JSON.stringify(message.messageId)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `Application input provenance, only for user message ${id}: this message contains speech transcription. Names and numbers may have been misrecognized. Use established conversation context to interpret them; ask a focused question only when a meaningful ambiguity remains. Do not silently rewrite the user's words or history. This note does not apply to other messages.`;
}

export function speechTranscriptionPrompt(
  message: Parameters<typeof speechTranscriptionContext>[0],
  text: string,
): string {
  const origin = speechTranscriptionContext(message);
  return origin ? `${text}\n\n${origin}` : text;
}
