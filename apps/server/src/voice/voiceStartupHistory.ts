export function voiceStartupHistory(
  messages: ReadonlyArray<{
    role: string;
    streaming: boolean;
    text: string;
  }>,
) {
  const items: Array<{ role: "user" | "assistant"; text: string }> = [];
  // Realtime V3 has a shared startup budget, including its developer instructions.
  let remaining = 16_000;
  for (let index = messages.length - 1; index >= 0 && items.length < 20; index--) {
    const message = messages[index]!;
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
