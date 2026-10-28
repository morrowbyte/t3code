import { assert, it } from "@effect/vitest";
import { voiceIntakeInstruction } from "./voiceIntakeInstruction.ts";

it("keeps the full multipart original instruction and preview without a model paraphrase", () => {
  const parts = [
    "After sending, show Sent and reset the form.",
    "Announce Sent to screen readers. Do not reload or open a dialog.",
  ];
  const preview = "button#send, form#contact; selected before classification";
  const text = voiceIntakeInstruction(
    parts.map((quote) => ({ quote })),
    preview,
  )!;
  for (const part of parts) assert.include(text, part);
  assert.include(text, preview);
  assert.notInclude(text, "publicly available for everyone");
});

it("separates completed original speech from the fresh instruction without model context", () => {
  const text = voiceIntakeInstruction(
    [{ quote: "Announce Sent to screen readers." }],
    "selected original form",
    [{ quote: "Add the Ready form." }],
  )!;
  assert.include(text, "already completed, do not repeat):\nAdd the Ready form.");
  assert.include(text, "User instruction (original speech):\nAnnounce Sent to screen readers.");
  assert.include(text, "selected original form");
});

it("preserves all eight 2k sources, completed reference and 24k preview beyond the 8k label limit", () => {
  const sources = Array.from({ length: 8 }, (_, index) => ({
    quote: `${index}:` + String(index).repeat(1_998),
  }));
  const completed = sources.map(({ quote }) => ({ quote: quote.replaceAll(":", ";") }));
  const preview = "p".repeat(24_000);
  const text = voiceIntakeInstruction(sources, preview, completed)!;
  assert.isAbove(text.length, 56_000);
  for (const { quote } of [...sources, ...completed]) assert.include(text, quote);
  assert.isTrue(text.endsWith(preview));
});

it("rejects an out-of-contract input without silently cutting its authorization", () => {
  assert.isUndefined(voiceIntakeInstruction([]));
  assert.isUndefined(voiceIntakeInstruction([{ quote: "x".repeat(2_001) }]));
  assert.isUndefined(voiceIntakeInstruction(Array.from({ length: 9 }, () => ({ quote: "x" }))));
  assert.isUndefined(voiceIntakeInstruction([{ quote: "x" }], "p".repeat(24_001)));
  assert.isUndefined(voiceIntakeInstruction([{ quote: "x" }], null, []));
});
