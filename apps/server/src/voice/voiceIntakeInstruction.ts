import type { VoiceIntakeSource } from "@t3tools/contracts";

type Quotes = ReadonlyArray<Pick<VoiceIntakeSource, "quote">>;

const validQuotes = (sources: Quotes) =>
  sources.length >= 1 &&
  sources.length <= 8 &&
  sources.every((source) => source.quote.trim().length > 0 && source.quote.length <= 2_000);

// Only exact, validated speech authorizes work. Classifier summaries are labels.
// The per-source limits permit 16k of instructions; never fit them into the 8k label limit.
export function voiceIntakeInstruction(
  sources: Quotes,
  previewContext?: string | null,
  completedSources?: Quotes,
): string | undefined {
  if (
    !validQuotes(sources) ||
    (completedSources !== undefined && !validQuotes(completedSources)) ||
    (previewContext !== undefined && previewContext !== null && previewContext.length > 24_000)
  )
    return;
  const quotes = (items: Quotes) => items.map((source) => source.quote).join("\n\n");
  return [
    ...(completedSources
      ? [
          `Completed work (original speech, reference only; already completed, do not repeat):\n${quotes(completedSources)}`,
        ]
      : []),
    `User instruction (original speech):\n${quotes(sources)}`,
    ...(previewContext ? [`Selected preview context (reference data):\n${previewContext}`] : []),
  ].join("\n\n");
}
