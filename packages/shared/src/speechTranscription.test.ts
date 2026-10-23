import { describe, expect, it } from "vite-plus/test";
import {
  editSpeechTranscriptionRanges,
  hasSpeechTranscription,
  speechTranscriptionContext,
  speechTranscriptionPrompt,
} from "./speechTranscription.ts";

describe("speech transcription provenance", () => {
  it("does not infer provenance from text, actor or the voice creation source", () => {
    const message = { messageId: "typed", createdBy: "user", creationSource: "voice" };
    expect(speechTranscriptionPrompt(message, "This is transcription: Plain37")).toBe(
      "This is transcription: Plain37",
    );
    expect(
      speechTranscriptionContext({
        ...message,
        createdBy: "agent",
        containsSpeechTranscription: true,
      }),
    ).toBeUndefined();
    expect(
      speechTranscriptionContext({
        ...message,
        senderThreadId: "source",
        containsSpeechTranscription: true,
      }),
    ).toBeUndefined();
    expect(speechTranscriptionContext({ ...message, containsSpeechTranscription: true })).toContain(
      "Names and numbers",
    );
  });

  it("retains known speech through typed insertions and deletes provenance when the actual span is replaced", () => {
    const ranges = [{ start: 0, end: 7 }];
    expect(editSpeechTranscriptionRanges("NodeX37", "NodeX37 morgen", ranges)).toEqual(ranges);
    expect(editSpeechTranscriptionRanges("NodeX37", "Mein NodeX37", ranges)).toEqual([
      { start: 5, end: 12 },
    ]);
    expect(
      editSpeechTranscriptionRanges("NodeX37", "NodeX37", ranges, { start: 0, end: 7 }),
    ).toEqual([]);
    expect(
      editSpeechTranscriptionRanges("NodeX37", "NodeY37", ranges, { start: 0, end: 7 }),
    ).toEqual([]);
    expect(editSpeechTranscriptionRanges("NodeX37", "", ranges)).toEqual([]);
    expect(hasSpeechTranscription("typed", [])).toBe(false);
    expect(hasSpeechTranscription("typed", [{ start: 3, end: 99 }])).toBe(false);
  });

  it("tracks UTF-16 positions without correcting names or keeping newly typed replacement text as speech", () => {
    const text = "🦊 NodeX37";
    const ranges = [{ start: 3, end: 10 }];
    const edited = "🦊 NodeX-37";
    const next = editSpeechTranscriptionRanges(text, edited, ranges);
    expect(next).toEqual([
      { start: 3, end: 8 },
      { start: 9, end: 11 },
    ]);
    expect(next.map((range) => edited.slice(range.start, range.end)).join("")).toBe("NodeX37");
    expect(text).toBe("🦊 NodeX37");
  });
});
