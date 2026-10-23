import type {
  LiveVoiceEvent,
  LiveVoiceHistoryEntry,
  LiveVoiceTranscriptSegment,
} from "@t3tools/contracts";

type TranscriptEvent = Extract<LiveVoiceEvent, { type: "transcript" }>;
type SegmentEntry = LiveVoiceHistoryEntry & { revision: number };

export function replayLiveVoiceTranscript(
  rows: ReadonlyArray<{
    eventId: number;
    recordedAt: string;
    event: LiveVoiceEvent;
  }>,
) {
  const entries = new Map<string, LiveVoiceHistoryEntry>();
  const segments = new Map<string, SegmentEntry>();
  const firstTimes = new Map<string, string>();
  const gaps = new Set<string>();
  const pending = new Map<
    string,
    {
      segment: LiveVoiceTranscriptSegment;
      speaker: TranscriptEvent["role"];
      parts: Map<number, string>;
    }
  >();

  for (const row of rows) {
    if (row.event.type !== "transcript") continue;
    const event = row.event;
    const segment = event.segment;
    if (!segment) {
      if (event.text.trim()) {
        const id = `event:${row.eventId}`;
        entries.set(id, {
          id,
          speaker: event.role,
          text: event.text,
          final: true,
          occurredAt: row.recordedAt,
          updatedAt: row.recordedAt,
        });
      }
      continue;
    }
    const id = `segment:${segment.id}`;
    const current = segments.get(segment.id);
    if (entries.get(id)?.speaker !== undefined && entries.get(id)!.speaker !== event.role) continue;
    if (current && (current.speaker !== event.role || segment.revision <= current.revision))
      continue;
    if (
      segment.kind === "delta" &&
      (current?.final || segment.revision !== (current?.revision ?? 0) + 1)
    ) {
      gaps.add(segment.id);
      continue;
    }
    if (!firstTimes.has(segment.id)) {
      firstTimes.set(segment.id, row.recordedAt);
      entries.set(id, {
        id: segment.id,
        speaker: event.role,
        text: "",
        final: false,
        occurredAt: row.recordedAt,
        updatedAt: row.recordedAt,
      });
    }
    let part = pending.get(segment.id);
    if (part && segment.revision < part.segment.revision) continue;
    if (!part || segment.revision > part.segment.revision) {
      part = { segment, speaker: event.role, parts: new Map() };
      pending.set(segment.id, part);
    }
    if (
      part.segment.partCount !== segment.partCount ||
      part.segment.kind !== segment.kind ||
      part.segment.final !== segment.final ||
      part.speaker !== event.role ||
      part.parts.has(segment.partIndex)
    )
      continue;
    part.parts.set(segment.partIndex, event.text);
    if (part.parts.size !== segment.partCount) continue;
    const text = Array.from({ length: segment.partCount }, (_, index) =>
      part.parts.get(index)!,
    ).join("");
    const entry: SegmentEntry = {
      id: segment.id,
      speaker: event.role,
      text: segment.kind === "delta" ? (current?.text ?? "") + text : text,
      final: segment.final,
      revision: segment.revision,
      occurredAt: firstTimes.get(segment.id)!,
      updatedAt: row.recordedAt,
    };
    segments.set(segment.id, entry);
    pending.delete(segment.id);
    if (segment.kind === "snapshot") gaps.delete(segment.id);
    // Keep the insertion position even when a later snapshot clears this segment.
    entries.set(id, {
      id: entry.id,
      speaker: entry.speaker,
      text: entry.text,
      final: entry.final,
      occurredAt: entry.occurredAt,
      updatedAt: entry.updatedAt,
    });
  }
  const visible = [...entries.values()].filter((entry) => entry.text.trim());
  return {
    entries: visible,
    incomplete: pending.size > 0 || gaps.size > 0 || visible.some((entry) => !entry.final),
  };
}
