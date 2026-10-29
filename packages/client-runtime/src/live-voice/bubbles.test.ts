import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { voiceSpeechBubbles, VOICE_BUBBLE_MAX_LENGTH } from "./bubbles.ts";
import {
  interleaveVoiceConversation,
  sameVoiceConversationItem,
  type VoiceConversationItem,
} from "./conversation.ts";

const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const at = "2026-10-28T10:00:00.000Z";

function speech(text: string, id = "segment", final = false): VoiceConversationItem {
  return {
    id: `voice:call:1:speech:${id}`,
    callKey: "call:1",
    createdAt: at,
    kind: "speech",
    entry: { id, speaker: "assistant", text, final, occurredAt: at, updatedAt: at },
  };
}

const spoken = (items: ReadonlyArray<VoiceConversationItem>) =>
  items.flatMap((item) => (item.kind === "speech" ? [item.entry.text] : []));

it("bounds long speech at sentences and words without losing whitespace or splitting surrogate pairs", () => {
  const sentence = "A received sentence. ".repeat(15);
  const words = "word ".repeat(200);
  for (const text of [sentence.repeat(4), words, "😀".repeat(500), "字".repeat(1000)]) {
    const bubbles = voiceSpeechBubbles([speech(text)], threadRef);
    expect(spoken(bubbles).join("")).toBe(text);
    expect(spoken(bubbles).every((part) => part.length <= VOICE_BUBBLE_MAX_LENGTH)).toBe(true);
    expect(spoken(bubbles).every((part) => !/[\uD800-\uDBFF]$/u.test(part))).toBe(true);
    if (text === words) expect(spoken(bubbles)[0]!.endsWith("word")).toBe(true);
    if (text === sentence.repeat(4)) expect(spoken(bubbles)[0]!.endsWith(".")).toBe(true);
  }
});

it("keeps source identities and completed prefixes through streaming, replacement, final and retraction", () => {
  const initial = "A complete sentence. ".repeat(40);
  const first = voiceSpeechBubbles([speech(initial)], threadRef);
  const grown = voiceSpeechBubbles([speech(`${initial}More received words.`)], threadRef);
  expect(grown.slice(0, -1)).toEqual(first.slice(0, -1));
  expect(grown.map((item) => item.id).slice(0, first.length)).toEqual(first.map((item) => item.id));
  expect(voiceSpeechBubbles([speech(`${initial}More received words.`)], threadRef)).toEqual(grown);
  const corrected = voiceSpeechBubbles([speech("Actual correction.", "segment", true)], threadRef);
  expect(corrected).toHaveLength(1);
  expect(corrected[0]).toMatchObject({
    id: first[0]!.id,
    entry: { text: "Actual correction.", final: true },
  });
  expect(voiceSpeechBubbles([speech("", "segment", true)], threadRef)).toEqual([]);
});

it("keeps segment and interruption boundaries without inventing silence or completion", () => {
  const notice: VoiceConversationItem = {
    id: "interrupted",
    callKey: "call:1",
    createdAt: at,
    kind: "notice",
    text: "Some transcript segments are incomplete.",
  };
  const first = speech("Yes.", "one", true);
  const next = speech("Yes.", "two");
  const interrupted = speech("Received partial reply.", "earlier");
  const ongoing = voiceSpeechBubbles([interrupted, first, next], threadRef);
  expect(ongoing[0]).toMatchObject({ entry: { final: false }, bubble: { settled: true } });
  expect(ongoing[2]).toMatchObject({ entry: { final: false }, bubble: { settled: false } });
  const end: VoiceConversationItem = {
    id: "call-end",
    callKey: "call:1",
    createdAt: at,
    kind: "call-end",
    call: {
      leaseId: "call",
      generation: 1,
      threadId: threadRef.threadId,
      firstEventId: 1,
      lastEventId: 4,
      startedAt: at,
      activeAt: at,
      endedAt: at,
      updatedAt: at,
      status: "unknown",
    },
  };
  const items = voiceSpeechBubbles([first, next, notice, end], threadRef);
  expect(spoken(items)).toEqual(["Yes.", "Yes."]);
  expect(items[0]!.id).toBe(first.id);
  expect(items[1]).toMatchObject({
    id: next.id,
    entry: { final: false },
    bubble: { settled: true },
  });
  expect(items[2]).toBe(notice);
  expect(items[3]).toBe(end);
  const chat = [
    { id: "approval", createdAt: at },
    { id: "inline-result", createdAt: at },
  ];
  expect(
    interleaveVoiceConversation<{ id: string; createdAt: string }>(chat, items).filter(
      (item) => !items.some((voice) => voice.id === item.id),
    ),
  ).toEqual(chat);
});

it("invalidates memoized rows when switching view or environment even when speech is unchanged", () => {
  const original = speech("Actual speech.");
  const bubble = voiceSpeechBubbles([original], threadRef)[0]!;
  const elsewhere = voiceSpeechBubbles([original], {
    ...threadRef,
    environmentId: EnvironmentId.make("local"),
  })[0]!;
  expect(sameVoiceConversationItem(original, bubble)).toBe(false);
  expect(sameVoiceConversationItem(bubble, elsewhere)).toBe(false);
  expect(sameVoiceConversationItem(bubble, voiceSpeechBubbles([original], threadRef)[0]!)).toBe(
    true,
  );
});
