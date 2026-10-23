import { describe, expect, it } from "@effect/vitest";
import { voiceAnswerParagraphs } from "./voiceAnswerParagraphs.ts";
import { voiceStartupHistory } from "./voiceStartupHistory.ts";

describe("public voice context", () => {
  it("releases closed paragraphs while retaining an unfinished tail and fenced UI", () => {
    expect(voiceAnswerParagraphs("First finding.\n\nUnfinished")).toEqual([
      { offset: 0, text: "First finding." },
    ]);
    expect(voiceAnswerParagraphs("Unfinished")).toEqual([]);
    expect(voiceAnswerParagraphs("First\n\n```t3-ui\n{}\n\n```\n\nNext\n\nTail")).toEqual([
      { offset: 0, text: "First" },
      { offset: 25, text: "Next" },
    ]);
  });

  it("keeps useful existing findings beyond the old 1000-character cutoff with bounded history", () => {
    const result = "Finding. ".repeat(400);
    const messages = [
      { role: "system", streaming: false, text: "Do not replay" },
      { role: "assistant", streaming: false, text: result },
      { role: "assistant", streaming: true, text: "Not complete" },
      { role: "user", streaming: false, text: "Tell me about those findings" },
    ];
    expect(voiceStartupHistory(messages)).toEqual([
      { role: "assistant", text: result },
      { role: "user", text: messages[3]!.text },
    ]);
    const bounded = voiceStartupHistory(
      Array.from({ length: 100 }, () => ({
        role: "assistant",
        streaming: false,
        text: "x".repeat(10_000),
      })),
    );
    expect(bounded.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(16_000);
  });
});
