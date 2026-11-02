import { describe, expect, it } from "@effect/vitest";
import { voiceAnswerParagraphs } from "./voiceAnswerParagraphs.ts";
import { voiceStartupHistory } from "./voiceStartupHistory.ts";
import { voiceIntakeInstruction } from "./voiceIntakeInstruction.ts";

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
    const typed = "Explain the literal marker Conversation context (reference only; in this file.";
    const sources = [
      { quote: "Correct the diagram", continuesPrevious: false },
      { quote: " and save the file.", continuesPrevious: true },
    ];
    const original = "Correct the diagram and save the file.";
    const originals = new Map([["voice-message", sources]]);
    let context = "Earlier conversation.";
    for (let call = 0; call < 3; call++) {
      const history = voiceStartupHistory(
        [
          { id: "typed-message", role: "user", streaming: false, text: typed },
          {
            id: "voice-message",
            role: "user",
            streaming: false,
            text: voiceIntakeInstruction(sources, null, undefined, context)!,
          },
          { id: "result", role: "assistant", streaming: false, text: result },
        ],
        originals,
      );
      expect(history).toEqual([
        { role: "user", text: typed },
        { role: "user", text: original },
        { role: "assistant", text: result },
      ]);
      context = history.map((item) => item.text).join("\n\n");
    }
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
