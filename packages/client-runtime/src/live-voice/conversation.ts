import type {
  LiveVoiceCallSummary,
  LiveVoiceCallTranscript,
  LiveVoiceHistoryEntry,
} from "@t3tools/contracts";
import type { LiveVoiceState } from "./controller.ts";

export type ObservedVoiceCall = {
  readonly environmentId: string;
  readonly call: LiveVoiceCallSummary;
  readonly entries: ReadonlyArray<LiveVoiceHistoryEntry>;
};

export type VoiceTranscriptSnapshot = {
  readonly transcript: LiveVoiceCallTranscript;
  readonly throughEventId: number;
};

export type VoiceConversationItem = {
  readonly id: string;
  readonly createdAt: string;
  readonly callKey: string;
} & (
  | { readonly kind: "speech"; readonly entry: LiveVoiceHistoryEntry }
  | { readonly kind: "call-start" | "call-end"; readonly call: LiveVoiceCallSummary }
  | { readonly kind: "notice"; readonly text: string }
);

export const voiceCallKey = (call: Pick<LiveVoiceCallSummary, "leaseId" | "generation">) =>
  `${call.leaseId}:${call.generation}`;

export function sameVoiceConversationItem(a: VoiceConversationItem, b: VoiceConversationItem) {
  if (a === b) return true;
  if (a.id !== b.id || a.kind !== b.kind || a.createdAt !== b.createdAt) return false;
  if (a.kind === "speech" && b.kind === "speech")
    return (
      a.entry.text === b.entry.text &&
      a.entry.final === b.entry.final &&
      a.entry.speaker === b.entry.speaker
    );
  if (a.kind === "notice" && b.kind === "notice") return a.text === b.text;
  if (a.kind === "call-end" && b.kind === "call-end") return a.call.status === b.call.status;
  return (
    a.kind === "call-start" &&
    b.kind === "call-start" &&
    a.call.status === b.call.status &&
    a.call.endedAt === b.call.endedAt
  );
}

// These are local receipt times, not audio onset times. Durable server receipts
// replace them when available, without moving a segment on every revision.
export function observeVoiceConversation(
  previous: ReadonlyArray<ObservedVoiceCall>,
  state: Pick<LiveVoiceState, "lease" | "phase" | "transcript">,
  receivedAt: string,
): ReadonlyArray<ObservedVoiceCall> {
  if (!state.lease) return previous;
  const lease = state.lease;
  const key = voiceCallKey(lease);
  const existing = previous.find((value) => voiceCallKey(value.call) === key);
  const entries = new Map(existing?.entries.map((entry) => [entry.id, entry]));
  for (const [index, segment] of state.transcript.entries()) {
    // Legacy events have no cross-client identity; only the persisted copy is
    // merged once history is available. Never deduplicate speech by its text.
    const id = segment.segmentId ?? `local:${index}`;
    const old = entries.get(id);
    entries.set(id, {
      id,
      speaker: segment.speaker,
      text: segment.text,
      final: segment.final,
      occurredAt: old?.occurredAt ?? receivedAt,
      updatedAt:
        old?.text === segment.text && old.final === segment.final ? old.updatedAt : receivedAt,
    });
  }
  const ended = ["ended", "error"].includes(state.phase);
  const call: LiveVoiceCallSummary = {
    ...lease,
    firstEventId: 0,
    lastEventId: 0,
    startedAt: existing?.call.startedAt ?? receivedAt,
    activeAt: existing?.call.activeAt ?? (state.phase === "live" ? receivedAt : null),
    endedAt: existing?.call.endedAt ?? (ended ? receivedAt : null),
    updatedAt: receivedAt,
    status: ended && !["closed", "failed"].includes(lease.status) ? "unknown" : lease.status,
  };
  const next = { call, environmentId: lease.environmentId, entries: [...entries.values()] };
  return existing
    ? previous.map((value) => (voiceCallKey(value.call) === key ? next : value))
    : [...previous, next];
}

export function retainVoiceCalls(
  previous: ReadonlyArray<LiveVoiceCallSummary>,
  incoming: ReadonlyArray<LiveVoiceCallSummary>,
): ReadonlyArray<LiveVoiceCallSummary> {
  const calls = new Map(previous.map((call) => [voiceCallKey(call), call]));
  let changed = false;
  for (const call of incoming) {
    const key = voiceCallKey(call);
    const old = calls.get(key);
    if (old && call.lastEventId < old.lastEventId) continue;
    if (
      !old ||
      old.lastEventId !== call.lastEventId ||
      old.status !== call.status ||
      old.updatedAt !== call.updatedAt
    ) {
      calls.set(key, call);
      changed = true;
    }
  }
  return changed ? [...calls.values()] : previous;
}

export function voiceConversationItems(
  calls: ReadonlyArray<LiveVoiceCallSummary>,
  transcripts: ReadonlyMap<string, LiveVoiceCallTranscript | VoiceTranscriptSnapshot | "error">,
  observed: ReadonlyArray<ObservedVoiceCall> = [],
): ReadonlyArray<VoiceConversationItem> {
  const summaries = new Map(calls.map((call) => [voiceCallKey(call), call]));
  for (const live of observed) {
    const key = voiceCallKey(live.call);
    const saved = summaries.get(key);
    if (!saved) summaries.set(key, live.call);
    else if (live.call.endedAt && !saved.endedAt)
      summaries.set(key, { ...saved, endedAt: live.call.endedAt, status: live.call.status });
  }
  const items: VoiceConversationItem[] = [];
  for (const [key, call] of summaries) {
    const prefix = `voice:${key}`;
    items.push({
      id: `${prefix}:start`,
      callKey: key,
      createdAt: call.startedAt,
      kind: "call-start",
      call,
    });
    const snapshot = transcripts.get(key);
    const saved =
      snapshot && snapshot !== "error" && "transcript" in snapshot ? snapshot.transcript : snapshot;
    if (saved === "error") {
      items.push({
        id: `${prefix}:error`,
        callKey: key,
        createdAt: call.startedAt,
        kind: "notice",
        text: "Couldn’t load this transcript.",
      });
    } else {
      const live = observed.find((value) => voiceCallKey(value.call) === key);
      const serverCall = calls.find((value) => voiceCallKey(value) === key);
      const settledSnapshot =
        serverCall?.endedAt &&
        saved &&
        (snapshot && snapshot !== "error" && "throughEventId" in snapshot
          ? snapshot.throughEventId >= serverCall.lastEventId
          : true);
      const entries = new Map(saved?.entries.map((entry) => [entry.id, entry]));
      for (const entry of live?.entries ?? []) {
        const persisted = entries.get(entry.id);
        if (!entry.id.startsWith("local:") || !saved) {
          // A closed call's complete read is authoritative. Until that receipt,
          // keep live corrections ahead of a delayed polling response.
          if (!persisted || (!settledSnapshot && (!persisted.final || entry.final)))
            entries.set(entry.id, {
              ...entry,
              occurredAt: persisted?.occurredAt ?? entry.occurredAt,
            });
        }
      }
      for (const entry of entries.values()) {
        if (entry.text.trim())
          items.push({
            id: `${prefix}:speech:${entry.id}`,
            callKey: key,
            createdAt: entry.occurredAt,
            kind: "speech",
            entry,
          });
      }
      if (saved?.incomplete)
        items.push({
          id: `${prefix}:incomplete`,
          callKey: key,
          createdAt: call.endedAt ?? call.startedAt,
          kind: "notice",
          text: "Some transcript segments are incomplete.",
        });
      if (saved && entries.size === 0 && call.endedAt)
        items.push({
          id: `${prefix}:empty`,
          callKey: key,
          createdAt: call.endedAt,
          kind: "notice",
          text: "No transcript was received.",
        });
    }
    if (call.endedAt)
      items.push({
        id: `${prefix}:end`,
        callKey: key,
        createdAt: call.endedAt,
        kind: "call-end",
        call,
      });
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Keep the work renderer's grouping/order intact. Voice has no run, command,
// message ID or provider context; it is a presentation row only.
export function interleaveVoiceConversation<T extends { readonly createdAt: string | null }>(
  rows: ReadonlyArray<T>,
  voice: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (!voice.length) return rows;
  const result: T[] = [];
  let index = 0;
  for (const row of rows) {
    const createdAt = row.createdAt;
    if (createdAt)
      while (index < voice.length && voice[index]!.createdAt! < createdAt)
        result.push(voice[index++]!);
    result.push(row);
  }
  result.push(...voice.slice(index));
  return result;
}
