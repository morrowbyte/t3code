import { describe, expect, it } from "vite-plus/test";
import type { LiveVoiceEvent } from "@t3tools/contracts";
import { replayLiveVoiceTranscript } from "./liveVoiceHistoryReplay.ts";

const transcript = (
  text: string,
  revision: number,
  kind: "snapshot" | "delta" = "snapshot",
  partIndex = 0,
  partCount = 1,
  final = false,
): Extract<LiveVoiceEvent, { type: "transcript" }> => ({
  type: "transcript",
  leaseId: "call",
  generation: 1,
  role: "user",
  text,
  segment: { id: "speech", revision, kind, partIndex, partCount, final },
});
const rows = (events: ReadonlyArray<LiveVoiceEvent>) =>
  events.map((event, index) => ({
    eventId: index + 1,
    recordedAt: `2026-10-23T18:00:${String(index).padStart(2, "0")}.000Z`,
    event,
  }));

describe("replayLiveVoiceTranscript", () => {
  it("keeps first-event speaker order when multipart segments complete out of order", () => {
    const result = replayLiveVoiceTranscript(
      rows([
        transcript("first ", 1, "snapshot", 0, 2, true),
        {
          ...transcript("second", 1, "snapshot", 0, 1, true),
          role: "assistant",
          segment: { ...transcript("", 1).segment!, id: "reply", final: true },
        },
        transcript("utterance", 1, "snapshot", 1, 2, true),
      ]),
    );
    expect(result.entries.map((entry) => entry.text)).toEqual(["first utterance", "second"]);
  });
  it("replaces segment revisions, appends exact deltas and assembles parts in order", () => {
    const result = replayLiveVoiceTranscript(
      rows([
        transcript("Hel", 1),
        transcript("lo", 2, "delta"),
        transcript("wrong stale text", 1),
        transcript(" world", 3, "snapshot", 1, 2, true),
        transcript("Hello", 3, "snapshot", 0, 2, true),
        transcript("Hello", 3, "snapshot", 0, 2, true),
      ]),
    );
    expect(result.incomplete).toBe(false);
    expect(result.entries).toEqual([
      {
        id: "speech",
        speaker: "user",
        text: "Hello world",
        final: true,
        occurredAt: "2026-10-23T18:00:00.000Z",
        updatedAt: "2026-10-23T18:00:04.000Z",
      },
    ]);
  });

  it("never guesses a missing delta or incomplete multipart snapshot", () => {
    const result = replayLiveVoiceTranscript(
      rows([
        transcript("received", 1),
        transcript(" gap", 3, "delta"),
        transcript("half", 4, "snapshot", 1, 2, true),
      ]),
    );
    expect(result.entries.map((entry) => entry.text)).toEqual(["received"]);
    expect(result.incomplete).toBe(true);
  });

  it("recovers a gap only from a complete newer snapshot and keeps speaker identity", () => {
    const conflicting = { ...transcript("corrupt", 4), role: "assistant" as const };
    const result = replayLiveVoiceTranscript(
      rows([
        transcript("received", 1),
        transcript("gap", 3, "delta"),
        transcript("actual provider snapshot", 4, "snapshot", 0, 1, true),
        conflicting,
      ]),
    );
    expect(result.entries.map((entry) => entry.text)).toEqual(["actual provider snapshot"]);
    expect(result.incomplete).toBe(false);
  });

  it("preserves every legacy turn including repeated speech and more than 24 turns", () => {
    const events = Array.from({ length: 35 }, () => {
      const { segment: _segment, ...event } = transcript(" Same received words ", 1);
      return event;
    });
    const result = replayLiveVoiceTranscript(rows(events));
    expect(result.entries).toHaveLength(35);
    expect(result.entries.every((entry) => entry.text === " Same received words ")).toBe(true);
  });

  it("allows a newer empty final snapshot to remove a provisional segment", () => {
    const result = replayLiveVoiceTranscript(
      rows([transcript("provisional", 1), transcript("", 2, "snapshot", 0, 1, true)]),
    );
    expect(result.entries).toEqual([]);
    expect(result.incomplete).toBe(false);
  });
});
