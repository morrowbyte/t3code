import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type LiveVoiceCallSummary,
  type LiveVoiceCallTranscript,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  interleaveVoiceConversation,
  observeVoiceConversation,
  retainVoiceCalls,
  voiceCallKey,
  voiceConversationItems,
} from "./conversation.ts";
import type { LiveVoiceLease, LiveVoiceState } from "./controller.ts";

const threadId = ThreadId.make("thread");
const at = (second: number) => `2026-10-23T21:00:${String(second).padStart(2, "0")}.000Z`;
const lease: LiveVoiceLease = {
  leaseId: "call",
  generation: 1,
  threadId,
  environmentId: EnvironmentId.make("env"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: null,
  plannerNativeThreadId: null,
  status: "active",
};
const call: LiveVoiceCallSummary = {
  ...lease,
  startedAt: at(0),
  activeAt: at(1),
  endedAt: at(9),
  updatedAt: at(9),
  firstEventId: 1,
  lastEventId: 20,
  status: "closed",
};
function state(transcript: LiveVoiceState["transcript"], phase: LiveVoiceState["phase"] = "live") {
  return { lease, phase, transcript };
}
function transcript(entries: LiveVoiceCallTranscript["entries"]): LiveVoiceCallTranscript {
  return {
    leaseId: call.leaseId,
    generation: call.generation,
    threadId,
    entries,
    incomplete: false,
  };
}

it("revises a live segment in its original chronological position around an ordinary result", () => {
  const partial = {
    segmentId: "asr",
    speaker: "user",
    text: "Compare the",
    final: false,
    revision: 1,
  } as const;
  const first = observeVoiceConversation([], state([partial]), at(2));
  const revised = observeVoiceConversation(
    first,
    state([{ ...partial, text: "Compare the models.", final: true, revision: 2 }]),
    at(5),
  );
  const voice = voiceConversationItems([], new Map(), revised);
  const speech = voice.filter((item) => item.kind === "speech");
  expect(speech).toHaveLength(1);
  expect(speech[0]).toMatchObject({
    createdAt: at(2),
    entry: { text: "Compare the models.", final: true },
  });
  expect(
    interleaveVoiceConversation<{ id: string; createdAt: string }>(
      [{ id: "assistant-result", createdAt: at(3) }],
      voice,
    ).map((row) => row.id),
  ).toEqual(["voice:call:1:start", "voice:call:1:speech:asr", "assistant-result"]);
});

it("merges persisted and live receipts by call and segment, retaining identical separate utterances", () => {
  const observed = observeVoiceConversation(
    [],
    state([
      { segmentId: "one", speaker: "user", text: "Yes.", final: true },
      { segmentId: "two", speaker: "user", text: "Yes.", final: true },
    ]),
    at(2),
  );
  const saved = transcript([
    { id: "one", speaker: "user", text: "Yes.", final: true, occurredAt: at(1), updatedAt: at(2) },
  ]);
  const items = voiceConversationItems([call], new Map([[voiceCallKey(call), saved]]), observed);
  expect(items.filter((item) => item.kind === "speech")).toHaveLength(2);
  expect(items.find((item) => item.id.endsWith(":speech:one"))?.createdAt).toBe(at(1));
  const second = { ...call, leaseId: "other-call", startedAt: at(20), endedAt: at(29) };
  expect(
    voiceConversationItems(
      [call, second],
      new Map([
        [voiceCallKey(call), saved],
        [voiceCallKey(second), { ...saved, leaseId: second.leaseId }],
      ]),
    )
      .filter((item) => item.kind === "speech")
      .map((item) => item.id),
  ).toEqual(["voice:call:1:speech:one", "voice:other-call:1:speech:one"]);
});

it("keeps final durable revisions on reload and never turns a missing transcript into speech", () => {
  const saved = transcript([
    {
      id: "one",
      speaker: "assistant",
      text: "Actual received reply",
      final: true,
      occurredAt: at(4),
      updatedAt: at(5),
    },
  ]);
  const observed = observeVoiceConversation(
    [],
    state([{ segmentId: "one", speaker: "assistant", text: "Actual received", final: false }]),
    at(4),
  );
  const history = new Map([[voiceCallKey(call), saved]]);
  expect(voiceConversationItems([call], history, observed)).toEqual(
    voiceConversationItems([call], history),
  );
  expect(
    voiceConversationItems([call], new Map([[voiceCallKey(call), transcript([])]])).filter(
      (item) => item.kind === "speech",
    ),
  ).toEqual([]);
  expect(
    voiceConversationItems([call], new Map([[voiceCallKey(call), transcript([])]])),
  ).toContainEqual(
    expect.objectContaining({ kind: "notice", text: "No transcript was received." }),
  );
});

it("shows live partial changes without copying the same segment again after persistence", () => {
  const saved = transcript([
    {
      id: "one",
      speaker: "user",
      text: "Compare",
      final: false,
      occurredAt: at(1),
      updatedAt: at(2),
    },
  ]);
  const observed = observeVoiceConversation(
    [],
    state([{ segmentId: "one", speaker: "user", text: "Compare both", final: false }]),
    at(3),
  );
  const items = voiceConversationItems(
    [{ ...call, status: "active", endedAt: null }],
    new Map([[voiceCallKey(call), saved]]),
    observed,
  );
  expect(items.filter((item) => item.kind === "speech")).toEqual([
    expect.objectContaining({
      createdAt: at(1),
      entry: expect.objectContaining({ text: "Compare both" }),
    }),
  ]);
});

it("retains received segments beyond a controller window and preserves ended calls before the next call", () => {
  const first = observeVoiceConversation(
    [],
    state([{ segmentId: "one", speaker: "user", text: "First", final: true }]),
    at(1),
  );
  const nextWindow = observeVoiceConversation(
    first,
    state([{ segmentId: "two", speaker: "assistant", text: "Second", final: true }]),
    at(2),
  );
  const ended = observeVoiceConversation(
    nextWindow,
    { ...state([]), lease: { ...lease, status: "closed" }, phase: "ended" },
    at(3),
  );
  const secondCall = observeVoiceConversation(
    ended,
    { ...state([]), lease: { ...lease, leaseId: "next" } },
    at(4),
  );
  const items = voiceConversationItems([], new Map(), secondCall);
  expect(items.filter((item) => item.kind === "speech")).toHaveLength(2);
  expect(items.filter((item) => item.kind === "call-start")).toHaveLength(2);
  expect(items.filter((item) => item.kind === "call-end")).toHaveLength(1);
});

it("uses one persisted copy for legacy speech with no cross-client segment identity", () => {
  const local = observeVoiceConversation(
    [],
    state([{ speaker: "user", text: "Actual legacy speech", final: true }]),
    at(1),
  );
  const saved = transcript([
    {
      id: "event:19",
      speaker: "user",
      text: "Actual legacy speech",
      final: true,
      occurredAt: at(1),
      updatedAt: at(1),
    },
  ]);
  expect(
    voiceConversationItems([call], new Map([[voiceCallKey(call), saved]]), local).filter(
      (item) => item.kind === "speech",
    ),
  ).toHaveLength(1);
});

it("retains earlier calls across a rolling recent page and avoids churn for unchanged summaries", () => {
  const retained = retainVoiceCalls([], [call]);
  expect(retainVoiceCalls(retained, [{ ...call }])).toBe(retained);
  expect(
    retainVoiceCalls(retained, [{ ...call, lastEventId: 1, status: "active", endedAt: null }]),
  ).toBe(retained);
  expect(retainVoiceCalls(retained, [{ ...call, leaseId: "second" }])).toHaveLength(2);
  const rows = [{ id: "normal", createdAt: at(0) }];
  expect(interleaveVoiceConversation(rows, [])).toBe(rows);
});

it("keeps a final live correction ahead of stale history until the closed call snapshot catches up", () => {
  const entry = {
    id: "one",
    speaker: "user",
    text: "Old final wording",
    final: true,
    occurredAt: at(1),
    updatedAt: at(2),
  } as const;
  const saved = transcript([entry]);
  const observed = observeVoiceConversation(
    [],
    state([
      {
        segmentId: "one",
        speaker: "user",
        text: "Corrected final wording",
        final: true,
        revision: 3,
      },
    ]),
    at(3),
  );
  const stale = new Map([
    [voiceCallKey(call), { transcript: saved, throughEventId: call.lastEventId - 1 }],
  ]);
  expect(
    voiceConversationItems([call], stale, observed).filter((item) => item.kind === "speech"),
  ).toEqual([
    expect.objectContaining({
      entry: expect.objectContaining({ text: "Corrected final wording" }),
    }),
  ]);
  const caughtUp = new Map([
    [
      voiceCallKey(call),
      {
        transcript: transcript([{ ...entry, text: "Server final wording" }]),
        throughEventId: call.lastEventId,
      },
    ],
  ]);
  expect(
    voiceConversationItems([call], caughtUp, observed).filter((item) => item.kind === "speech"),
  ).toEqual([
    expect.objectContaining({ entry: expect.objectContaining({ text: "Server final wording" }) }),
  ]);
});
