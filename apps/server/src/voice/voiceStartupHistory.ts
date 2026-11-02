import type { VoiceIntakeSource } from "@t3tools/contracts";

type OriginalSources = ReadonlyArray<Pick<VoiceIntakeSource, "quote" | "continuesPrevious">>;

export function voiceOriginalSpeech(sources: OriginalSources) {
  return sources
    .map((source, index) => `${index && !source.continuesPrevious ? "\n\n" : ""}${source.quote}`)
    .join("");
}

export function voiceHistoryMessages<Message extends { id?: string; role: string; text: string }>(
  messages: ReadonlyArray<Message>,
  originals: ReadonlyMap<string, OriginalSources>,
) {
  return messages.map((message) => {
    const sources =
      message.role === "user" && message.id !== undefined ? originals.get(message.id) : undefined;
    return sources ? { ...message, text: voiceOriginalSpeech(sources) } : message;
  });
}

export function voiceStartupHistory(
  messages: ReadonlyArray<{
    id?: string;
    role: string;
    streaming: boolean;
    text: string;
  }>,
  originals?: ReadonlyMap<string, OriginalSources>,
) {
  const history = originals ? voiceHistoryMessages(messages, originals) : messages;
  const items: Array<{ role: "user" | "assistant"; text: string }> = [];
  // Realtime V3 has a shared startup budget, including its developer instructions.
  let remaining = 16_000;
  for (let index = history.length - 1; index >= 0 && items.length < 20; index--) {
    const message = history[index]!;
    if (
      message.streaming ||
      (message.role !== "user" && message.role !== "assistant") ||
      !message.text.trim()
    )
      continue;
    const text = message.text.slice(0, Math.min(6_000, remaining));
    if (!text) break;
    items.unshift({ role: message.role, text });
    remaining -= text.length;
  }
  return items;
}
