import type { ScopedThreadRef } from "@t3tools/contracts";
import type { VoiceConversationItem } from "./conversation.ts";

export const VOICE_BUBBLE_MAX_LENGTH = 420;

function splitSpeech(text: string): ReadonlyArray<string> {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > VOICE_BUBBLE_MAX_LENGTH) {
    const prefix = remaining.slice(0, VOICE_BUBBLE_MAX_LENGTH);
    let sentenceEnd = 0;
    for (const match of prefix.matchAll(/[.!?。！？][”’"')\]]?(?=\s)/gu)) {
      sentenceEnd = match.index + match[0].length;
    }
    const wordEnd = /\s+\S*$/u.exec(prefix)?.index ?? 0;
    let end = sentenceEnd >= VOICE_BUBBLE_MAX_LENGTH / 2 ? sentenceEnd : wordEnd;
    if (end < VOICE_BUBBLE_MAX_LENGTH / 2) end = VOICE_BUBBLE_MAX_LENGTH;
    if (/[\uD800-\uDBFF]/u.test(remaining[end - 1]!)) end--;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function voiceSpeechBubbles(
  items: ReadonlyArray<VoiceConversationItem>,
  threadRef: ScopedThreadRef,
): ReadonlyArray<VoiceConversationItem> {
  const settled = new Set(
    items.flatMap((item) => (item.kind === "call-end" ? [item.callKey] : [])),
  );
  const latestSpeech = new Map<string, string>();
  for (const item of items) {
    if (item.kind === "speech") latestSpeech.set(item.callKey, item.id);
  }
  return items.flatMap((item): VoiceConversationItem[] => {
    if (item.kind !== "speech") return [item];
    // Segment boundaries are the only pause signal available; receipt times are not audio times.
    return splitSpeech(item.entry.text).map((text, index) => ({
      ...item,
      id: index === 0 ? item.id : `voice-bubble:${JSON.stringify([item.id, index])}`,
      bubble: {
        ...threadRef,
        settled: settled.has(item.callKey) || latestSpeech.get(item.callKey) !== item.id,
      },
      entry: { ...item.entry, text },
    }));
  });
}
