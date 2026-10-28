import { assert, it } from "@effect/vitest";
import { LiveVoiceError } from "@t3tools/contracts";
import type {
  LiveVoiceEvent,
  VoiceIntakeDecision,
  VoiceIntakeIntent,
  VoiceIntakeSource,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { makeVoiceIntake, type VoiceIntakeDependencies } from "./VoiceIntake.ts";

const source = (
  text: string,
  segmentId = "segment-a",
  revision = 1,
  start = 0,
): VoiceIntakeSource => ({
  segmentId,
  revision,
  start,
  end: start + text.length,
  quote: text,
  stopId: null,
});
const transcript = (
  text: string,
  revision = 1,
  final = false,
  id = "segment-a",
): LiveVoiceEvent => ({
  type: "transcript",
  leaseId: "lease",
  generation: 1,
  role: "user",
  text,
  segment: { id, revision, kind: "snapshot", final, partIndex: 0, partCount: 1 },
});
const setup = (
  decide: VoiceIntakeDependencies["decide"],
  provisionalAllowed = true,
  loseFirstSteerReply = false,
) => {
  const admitted: VoiceIntakeIntent[] = [];
  const steered: string[] = [];
  const confirmed: string[] = [];
  const admittedContexts: Array<string | null | undefined> = [];
  const steeredContexts: Array<string | null | undefined> = [];
  let previewContext: string | null = null;
  const steerKeys = new Set<string>();
  const attemptedSteerKeys: string[] = [];
  let loseReply = loseFirstSteerReply;
  let current = true;
  let completed = false;
  let status: string | undefined;
  let stopId: string | null | undefined = null;
  const engine = makeVoiceIntake({
    leaseId: "lease",
    generation: 1,
    provisionalAllowed,
    getPreviewContext: () => previewContext,
    decide,
    current: Effect.sync(() => current),
    stopId: Effect.sync(() => stopId),
    admit: (provenance, request, _projectId, context) =>
      Effect.sync(() => {
        admittedContexts.push(context);
        const intent: VoiceIntakeIntent = {
          id: provenance.intentId,
          request,
          sources: provenance.sources,
          claimedSources: provenance.sources,
          provisional: provenance.provisional,
          startedProvisional: provenance.provisional,
          pendingSteer: null,
          taskId: `task:${admitted.length}`,
          threadId: `child:${admitted.length}`,
          runId: `run:${admitted.length}`,
          status: "running",
          result: null,
        };
        admitted.push(intent);
        return intent;
      }),
    read: (intent) =>
      Effect.succeed(
        completed
          ? { ...intent, status: "completed", result: "Existing public result." }
          : status
            ? { ...intent, status }
            : intent,
      ),
    steer: (intent, message, requestId, _readOnly, context) =>
      Effect.gen(function* () {
        attemptedSteerKeys.push(requestId);
        if (!steerKeys.has(requestId)) {
          steerKeys.add(requestId);
          steered.push(message);
          steeredContexts.push(context);
        }
        if (loseReply) {
          loseReply = false;
          return yield* new LiveVoiceError({ code: "runtime_unavailable" });
        }
        return intent;
      }),
    confirm: (intent) =>
      Effect.sync(() => {
        confirmed.push(intent.id);
      }),
    store: () => Effect.void,
  });
  return {
    engine: {
      ...engine,
      observe: (event: LiveVoiceEvent, marker: string | null | undefined = null) =>
        engine.observe(event, marker),
    },
    observeUnbound: engine.observe,
    setStopId: (value: string | null | undefined) => {
      stopId = value;
    },
    admitted,
    admittedContexts,
    steeredContexts,
    setPreviewContext: (context: string | null) => {
      previewContext = context;
    },
    steered,
    confirmed,
    attemptedSteerKeys,
    setCurrent: (value: boolean) => {
      current = value;
    },
    complete: () => {
      completed = true;
    },
    setStatus: (value: string) => {
      status = value;
    },
  };
};

it.effect("admits a clear partial once before final, then confirms the same task", () =>
  Effect.gen(function* () {
    const text = "Research two CI runner projects.";
    const test = setup((snapshot) =>
      Effect.succeed({
        requestId: snapshot.requestId,
        actions: snapshot.intents[0]
          ? [
              {
                type: "confirm" as const,
                intentId: snapshot.intents[0].id,
                sources: [source(text, "segment-a", snapshot.segments[0]!.revision)],
              },
            ]
          : [
              {
                type: "new" as const,
                projectId: null,
                sources: [source(text)],
                request: text,
                readOnly: true,
              },
            ],
      }),
    );
    yield* test.engine.observe(transcript(text));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 1);
    assert.isTrue(test.admitted[0]!.provisional);
    yield* test.engine.observe(transcript(text, 2, false));
    yield* test.engine.processLatest();
    assert.deepEqual(
      test.confirmed,
      [],
      "explicit confirmation of provisional research still requires final sources",
    );
    yield* test.engine.observe(transcript(text, 3, true));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 1);
    assert.deepEqual(test.confirmed, [test.admitted[0]!.id]);
    assert.isFalse((yield* test.engine.state).intents[0]!.provisional);
  }),
);

it.effect(
  "discards a corrected in-flight decision and drops pending work on lease end or optout",
  () =>
    Effect.gen(function* () {
      const text = "Research CI runners.";
      for (const stop of ["correction", "endcall", "optout", "auth"] as const) {
        const started = yield* Deferred.make<void>();
        const result = yield* Deferred.make<VoiceIntakeDecision>();
        let requestId = "";
        const test = setup((snapshot) =>
          Effect.gen(function* () {
            requestId = snapshot.requestId;
            yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(result);
          }),
        );
        yield* test.engine.observe(transcript(text));
        const pending = yield* test.engine.processLatest().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        if (stop === "correction")
          yield* test.engine.observe(transcript("Do not research CI runners.", 2));
        else if (stop === "auth") test.setCurrent(false);
        else yield* test.engine.stop;
        yield* Deferred.succeed(result, {
          requestId,
          actions: [
            {
              type: "new",
              projectId: null,
              sources: [source(text)],
              request: text,
              readOnly: true,
            },
          ],
        });
        yield* Fiber.join(pending);
        assert.equal(test.admitted.length, 0, stop);
      }
    }),
);

it.effect("keeps independent spans separate and refines one task across segments", () =>
  Effect.gen(function* () {
    const first = "Research runners.";
    const second = "Compare costs.";
    let round = 0;
    const test = setup((snapshot) =>
      Effect.succeed({
        requestId: snapshot.requestId,
        actions:
          round++ === 0
            ? [
                {
                  type: "new",
                  projectId: null,
                  sources: [source(first)],
                  request: first,
                  readOnly: true,
                },
                {
                  type: "new",
                  projectId: null,
                  sources: [source(second, "segment-a", 1, first.length + 1)],
                  request: second,
                  readOnly: true,
                },
              ]
            : [
                {
                  type: "refine",
                  intentId: snapshot.intents[0]!.id,
                  sources: [source("Use original sources.", "segment-b")],
                  message: "Use original sources.",
                  readOnly: true,
                },
              ],
      }),
    );
    yield* test.engine.observe(transcript(`${first} ${second}`));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 2);
    yield* test.engine.observe(transcript("Use original sources.", 1, false, "segment-b"));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 2);
    assert.deepEqual(test.steered, ["Use original sources."]);
    test.complete();
    yield* test.engine.processLatest();
    assert.equal(test.steered.length, 1);
    assert.equal((yield* test.engine.state).intents[0]!.result, "Existing public result.");
  }),
);

it.effect(
  "starts a complete authorized mutation before ASR final without provisional restrictions",
  () =>
    Effect.gen(function* () {
      const text = "Change the build configuration.";
      const test = setup((snapshot) =>
        Effect.succeed({
          requestId: snapshot.requestId,
          actions: [
            {
              type: "new",
              projectId: null,
              sources: [source(text, "segment-a", snapshot.segments[0]!.revision)],
              request: text,
              readOnly: false,
            },
          ],
        }),
      );
      yield* test.engine.observe(transcript(text));
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 1);
      assert.isFalse(test.admitted[0]!.provisional);
      assert.isFalse(test.admitted[0]!.startedProvisional);
      yield* test.engine.observe(transcript(text, 2, true));
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 1);
      assert.isFalse(test.admitted[0]!.provisional);
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 1);
    }),
);

it.effect(
  "keeps one active decision and replaces its pending snapshot without losing independent tasks",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const snapshots: number[] = [];
      const test = setup((snapshot) =>
        Effect.gen(function* () {
          snapshots.push(snapshot.version);
          if (snapshots.length === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return {
            requestId: snapshot.requestId,
            actions: snapshot.segments
              .filter(
                (segment) =>
                  !snapshot.intents.some((intent) =>
                    intent.sources.some((source) => source.segmentId === segment.id),
                  ),
              )
              .map((segment) => ({
                type: "new" as const,
                projectId: null,
                sources: [source(segment.text, segment.id, segment.revision)],
                request: segment.text,
                readOnly: true,
              })),
          };
        }),
      );
      yield* test.engine.observe(transcript("Research A."));
      const first = yield* test.engine.processLatest().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* test.engine.observe(transcript("Research B.", 1, false, "b"));
      yield* test.engine.processLatest();
      yield* test.engine.observe(transcript("Research C.", 1, false, "c"));
      yield* test.engine.processLatest();
      assert.deepEqual(snapshots, [1]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* test.engine.processLatest();
      assert.deepEqual(snapshots, [1, 3]);
      assert.equal(test.admitted.length, 3);
      assert.isTrue(test.admitted.every((intent) => intent.status === "running"));
    }),
);

it.effect(
  "requires semantic final confirmation and keeps a late final from widening an in-flight partial",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const text = "Research runners.";
      const test = setup((snapshot) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return {
            requestId: snapshot.requestId,
            actions: [
              {
                type: "new" as const,
                projectId: null,
                sources: [source(text, "segment-a", snapshot.segments[0]!.revision)],
                request: text,
                readOnly: true,
              },
            ],
          };
        }),
      );
      yield* test.engine.observe(transcript(text));
      const pending = yield* test.engine.processLatest().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* test.engine.observe(transcript(text, 2, true));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      assert.isTrue(test.admitted[0]!.provisional);
      assert.deepEqual(test.confirmed, []);
    }),
);

it.effect("fails closed on transcript gaps, unknown intent IDs and explicit optout", () =>
  Effect.gen(function* () {
    let decisions = 0;
    const test = setup((snapshot) =>
      Effect.succeed({
        requestId: snapshot.requestId,
        actions:
          ++decisions === 1
            ? [
                {
                  type: "refine" as const,
                  intentId: "unknown",
                  sources: [source("Research A.", "segment-a", snapshot.segments[0]!.revision)],
                  message: "Do this",
                  readOnly: true,
                },
              ]
            : [{ type: "opt_out" as const }],
      }),
    );
    const gap = {
      ...transcript("Research A.", 2),
      segment: {
        id: "segment-a",
        revision: 2,
        kind: "delta" as const,
        final: false,
        partIndex: 0,
        partCount: 1,
      },
    };
    yield* test.engine.observe(gap);
    yield* test.engine.processLatest();
    assert.equal(decisions, 0);
    yield* test.engine.observe(transcript("Research A.", 3));
    yield* test.engine.processLatest();
    assert.equal((yield* test.engine.state).reason, "intent_unknown");
    assert.equal(test.admitted.length, 0);
    yield* test.engine.observe(transcript("Stop automatic intake.", 1, true, "optout"));
    yield* test.engine.processLatest();
    assert.isFalse((yield* test.engine.state).enabled);
    yield* test.engine.observe(transcript("Research B.", 1, true, "late"));
    yield* test.engine.processLatest();
    assert.equal(decisions, 2);
    assert.equal(test.admitted.length, 0);
  }),
);

it.effect(
  "anchors the three actual Luna quotes without relying on its incorrect character arithmetic",
  () =>
    Effect.gen(function* () {
      const statements = [
        "Recherchiere zwei selbst gehostete CI-Runner-Projekte.",
        "Vergleiche unabhängig davon die Kosten zweier Cloud-CI-Runner.",
        "Entwirf ein Balkendiagramm mit den fiktiven Bauzeiten 8, 3 und 2 Minuten.",
      ];
      const incorrectEnds = [45, 53, 67];
      const test = setup((snapshot) =>
        Effect.succeed({
          requestId: snapshot.requestId,
          actions: statements.map((text, index) => ({
            type: "new" as const,
            projectId: "current-project",
            request: text,
            readOnly: true,
            sources: [
              {
                segmentId: `source-${index}`,
                revision: 1,
                quote: text,
                start: 0,
                end: incorrectEnds[index]!,
              },
            ],
          })),
        }),
      );
      for (const [index, text] of statements.entries())
        yield* test.engine.observe(transcript(text, 1, false, `source-${index}`));
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 3);
      for (const [index, intent] of test.admitted.entries()) {
        assert.equal(intent.sources[0]!.end, statements[index]!.length);
        assert.equal(intent.sources[0]!.quote, statements[index]);
        assert.isTrue(intent.provisional);
      }
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 3);
    }),
);

it.effect(
  "rejects ambiguous repeated quotes and keeps confirmed work usable when provisional research is unavailable",
  () =>
    Effect.gen(function* () {
      const text = "Research runners.";
      const test = setup(
        (snapshot) =>
          Effect.succeed({
            requestId: snapshot.requestId,
            actions: [
              {
                type: "new",
                projectId: null,
                sources: [source(text, "segment-a", snapshot.segments[0]!.revision)],
                request: text,
                readOnly: true,
              },
            ],
          }),
        false,
      );
      yield* test.engine.observe(transcript(text));
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 0);
      assert.equal((yield* test.engine.state).reason, "provisional_unavailable");
      yield* test.engine.observe(transcript(text, 2, true));
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 1);
      assert.isFalse(test.admitted[0]!.provisional);
      const ambiguous = setup((snapshot) =>
        Effect.succeed({
          requestId: snapshot.requestId,
          actions: [
            {
              type: "new",
              projectId: null,
              sources: [source(text)],
              request: text,
              readOnly: true,
            },
          ],
        }),
      );
      yield* ambiguous.engine.observe(transcript(`${text} ${text}`));
      yield* ambiguous.engine.processLatest();
      assert.equal(ambiguous.admitted.length, 0);
    }),
);

it.effect(
  "replays an ambiguous steer with its persisted identity instead of losing it or applying it twice",
  () =>
    Effect.gen(function* () {
      let round = 0;
      const test = setup(
        (snapshot) =>
          Effect.succeed({
            requestId: snapshot.requestId,
            actions:
              round++ === 0
                ? [
                    {
                      type: "new" as const,
                      projectId: null,
                      request: "Research runners.",
                      sources: [source("Research runners.")],
                      readOnly: true,
                    },
                  ]
                : round === 2
                  ? [
                      {
                        type: "refine" as const,
                        intentId: snapshot.intents[0]!.id,
                        sources: [source("Use original sources.", "refinement")],
                        message: "Use original sources.",
                        readOnly: true,
                      },
                    ]
                  : [],
          }),
        true,
        true,
      );
      yield* test.engine.observe(transcript("Research runners."));
      yield* test.engine.processLatest();
      yield* test.engine.observe(transcript("Use original sources.", 1, false, "refinement"));
      const first = yield* test.engine.processLatest().pipe(Effect.result);
      assert.equal(first._tag, "Failure");
      const pending = (yield* test.engine.state).intents[0]!.pendingSteer!;
      assert.equal(pending.message, "Use original sources.");
      yield* test.engine.observe(transcript("What is the current status?", 1, true, "status"));
      yield* test.engine.processLatest();
      assert.deepEqual(test.attemptedSteerKeys, [pending.requestId, pending.requestId]);
      assert.deepEqual(test.steered, ["Use original sources."]);
      assert.isNull((yield* test.engine.state).intents[0]!.pendingSteer);
      assert.equal(test.admitted.length, 1);
    }),
);

it.effect("retains original ownership after more than eight refinements", () =>
  Effect.gen(function* () {
    let refinement = 0;
    const test = setup((snapshot) =>
      Effect.succeed({
        requestId: snapshot.requestId,
        actions:
          !snapshot.intents.length || refinement === 10
            ? [
                {
                  type: "new" as const,
                  projectId: null,
                  request: "Research runners.",
                  sources: [source("Research runners.")],
                  readOnly: true,
                },
              ]
            : [
                {
                  type: "refine" as const,
                  intentId: snapshot.intents[0]!.id,
                  sources: [source(`Constraint ${refinement}.`, `refine-${refinement}`)],
                  message: `Constraint ${refinement}.`,
                  readOnly: true,
                },
              ],
      }),
    );
    yield* test.engine.observe(transcript("Research runners."));
    yield* test.engine.processLatest();
    for (refinement = 1; refinement <= 9; refinement++) {
      yield* test.engine.observe(
        transcript(`Constraint ${refinement}.`, 1, false, `refine-${refinement}`),
      );
      yield* test.engine.processLatest();
    }
    yield* test.engine.observe(transcript("Current status?", 1, true, "status"));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 1);
    assert.equal(test.steered.length, 9);
    assert.equal((yield* test.engine.state).intents[0]!.sources.length, 8);
    assert.equal((yield* test.engine.state).intents[0]!.claimedSources.length, 10);
  }),
);

it.effect("discards Stop during a decision and never rebinds old finals to fresh speech", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let round = 0;
    const test = setup((snapshot) =>
      Effect.gen(function* () {
        if (round++ === 0) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(finish);
        }
        return {
          requestId: snapshot.requestId,
          actions: snapshot.segments.map((segment) => ({
            type: "new" as const,
            projectId: null,
            request: segment.text,
            readOnly: true,
            sources: [{ segmentId: segment.id, revision: segment.revision, quote: segment.text }],
          })),
        };
      }),
    );
    yield* test.engine.observe(transcript("Research the old task."));
    const deciding = yield* test.engine.processLatest().pipe(Effect.forkChild);
    yield* Deferred.await(started);
    test.setStopId("committed-stop");
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(deciding);
    assert.equal(test.admitted.length, 0, "Stop invalidates the captured decision");
    yield* test.engine.observe(transcript("Research the old task.", 2, true), "committed-stop");
    yield* test.engine.observe(
      transcript("Research a fresh task.", 1, true, "new-segment"),
      "committed-stop",
    );
    yield* test.engine.processLatest();
    assert.deepEqual(
      test.admitted.map((intent) => intent.request),
      ["Research a fresh task."],
    );
    test.setStopId(undefined);
    yield* test.observeUnbound(transcript("Invisible marker.", 1, true, "missing"));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 1, "missing marker visibility fails closed");
    test.setStopId("committed-stop");
    yield* test.engine.observe(
      transcript("Invisible marker.", 2, true, "missing"),
      "committed-stop",
    );
    yield* test.engine.processLatest();
    assert.equal(
      test.admitted.length,
      1,
      "a late final cannot recover unknown original authorization",
    );
  }),
);

it.effect("claims explicit final confirmation so it cannot become a second task", () =>
  Effect.gen(function* () {
    let round = 0;
    const first = "Research runner options.";
    const final = "Yes, carry out that runner research.";
    const test = setup((snapshot) =>
      Effect.succeed({
        requestId: snapshot.requestId,
        actions:
          ++round === 1
            ? [
                {
                  type: "new" as const,
                  projectId: null,
                  request: first,
                  sources: [source(first)],
                  readOnly: true,
                },
              ]
            : round === 2
              ? [
                  {
                    type: "confirm" as const,
                    intentId: snapshot.intents[0]!.id,
                    sources: [source(final, "confirmation")],
                  },
                ]
              : [
                  {
                    type: "new" as const,
                    projectId: null,
                    request: final,
                    sources: [source(final, "confirmation")],
                    readOnly: true,
                  },
                ],
      }),
    );
    yield* test.engine.observe(transcript(first));
    yield* test.engine.processLatest();
    yield* test.engine.observe(transcript(final, 1, true, "confirmation"));
    yield* test.engine.processLatest();
    yield* test.engine.observe(transcript("Thank you.", 1, true, "conversation"));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 1, "a claimed confirmation belongs to the existing task");
    assert.equal(test.confirmed.length, 1);
  }),
);

it.effect("continues a confirmed provisional task once without admitting replacement work", () =>
  Effect.gen(function* () {
    let round = 0;
    const first = "Research the configuration change.";
    const final = "Yes, implement that configuration change now.";
    const test = setup((snapshot) =>
      Effect.succeed({
        requestId: snapshot.requestId,
        actions:
          ++round === 1
            ? [
                {
                  type: "new" as const,
                  projectId: null,
                  request: first,
                  sources: [source(first)],
                  readOnly: true,
                },
              ]
            : [
                ...(round === 2
                  ? [
                      {
                        type: "confirm" as const,
                        intentId: snapshot.intents[0]!.id,
                        sources: [source(final, "confirmed-write")],
                      },
                    ]
                  : []),
                {
                  type: "refine" as const,
                  intentId: snapshot.intents[0]!.id,
                  sources: [source(final, "confirmed-write")],
                  message: final,
                  readOnly: false,
                },
              ],
      }),
    );
    yield* test.engine.observe(transcript(first));
    yield* test.engine.processLatest();
    const original = test.admitted[0]!;
    yield* test.engine.observe(transcript(final, 1, true, "confirmed-write"));
    yield* test.engine.processLatest();
    yield* test.engine.observe(transcript("Thank you.", 1, true, "conversation"));
    yield* test.engine.processLatest();
    assert.deepEqual(test.steered, [final]);
    assert.equal(test.admitted.length, 1);
    const intent = (yield* test.engine.state).intents[0]!;
    assert.equal(intent.taskId, original.taskId);
    assert.equal(intent.runId, original.runId);
    assert.isFalse(intent.provisional);
    assert.isFalse(intent.startedProvisional);
  }),
);

it.effect(
  "executes authorized clauses during continuously growing speech and coalesces two tasks plus later steering",
  () =>
    Effect.gen(function* () {
      const pending = yield* Queue.unbounded<{
        snapshot: Parameters<VoiceIntakeDependencies["decide"]>[0];
        answer: Deferred.Deferred<VoiceIntakeDecision>;
      }>();
      let calls = 0;
      let maxCalls = 0;
      const test = setup((snapshot) =>
        Effect.gen(function* () {
          calls += 1;
          maxCalls = Math.max(maxCalls, calls);
          const answer = yield* Deferred.make<VoiceIntakeDecision>();
          yield* Queue.offer(pending, { snapshot, answer });
          return yield* Deferred.await(answer).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                calls -= 1;
              }),
            ),
          );
        }),
      );
      test.setPreviewContext("button#original");
      const firstClause = "Ähm, baue bitte ein Suchfeld in die Einstellungsseite.";
      let text = firstClause;
      yield* test.engine.observe(transcript(text));
      const firstRun = yield* test.engine.processLatest().pipe(Effect.forkChild);
      const first = yield* Queue.take(pending);
      for (const [index, tail] of [
        " Ich beschreibe noch",
        " die Kategorien und Filter.",
        " Zusätzlich füge eine Exportfunktion hinzu.",
        " Dabei rede ich weiter",
        " über die nächsten Details.",
      ].entries()) {
        text += tail;
        yield* test.engine.observe(transcript(text, index + 2));
        yield* test.engine.processLatest();
      }
      test.setPreviewContext("button#changed");
      yield* Deferred.succeed(first.answer, {
        requestId: first.snapshot.requestId,
        actions: [
          {
            type: "new",
            projectId: null,
            readOnly: false,
            request: firstClause,
            sources: [source(firstClause)],
          },
        ],
      });
      yield* Fiber.join(firstRun);
      assert.equal(
        test.admitted.length,
        1,
        "first mutation starts during continued speech, before final",
      );
      assert.isFalse(test.admitted[0]!.provisional);
      assert.equal(test.admittedContexts[0], "button#original");
      const secondRun = yield* test.engine.processLatest().pipe(Effect.forkChild);
      const second = yield* Queue.take(pending);
      assert.equal(second.snapshot.version, 6, "intermediate revisions coalesce");
      text += " Verwende dunkle Farben für das Suchfeld.";
      yield* test.engine.observe(transcript(text, 7));
      yield* Deferred.succeed(second.answer, {
        requestId: second.snapshot.requestId,
        actions: [
          {
            type: "new",
            projectId: null,
            readOnly: false,
            request: firstClause,
            sources: [source(firstClause, "segment-a", 6)],
          },
          {
            type: "new",
            projectId: null,
            readOnly: false,
            request: "Füge eine Exportfunktion hinzu.",
            sources: [source("Zusätzlich füge eine Exportfunktion hinzu.", "segment-a", 6)],
          },
        ],
      });
      yield* Fiber.join(secondRun);
      assert.equal(test.admitted.length, 2);
      const refineRun = yield* test.engine.processLatest().pipe(Effect.forkChild);
      const refine = yield* Queue.take(pending);
      text += " Ich erläutere währenddessen den nächsten Schritt.";
      yield* test.engine.observe(transcript(text, 8));
      yield* Deferred.succeed(refine.answer, {
        requestId: refine.snapshot.requestId,
        actions: [
          {
            type: "refine",
            intentId: test.admitted[0]!.id,
            readOnly: false,
            message: "Verwende dunkle Farben.",
            sources: [source("Verwende dunkle Farben für das Suchfeld.", "segment-a", 7)],
          },
        ],
      });
      yield* Fiber.join(refineRun);
      assert.deepEqual(test.steered, ["Verwende dunkle Farben."]);
      assert.equal(maxCalls, 1);
      assert.equal(test.admitted.length, 2);
    }),
);

it.effect(
  "rejects delayed negation and abandoned replacements, keeps questions direct, and steers a complete correction before final",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      const clause = "Ändere das ausgewählte Menü.";
      const test = setup((snapshot) =>
        Effect.gen(function* () {
          if (first) {
            first = false;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return {
              requestId: snapshot.requestId,
              actions: [
                {
                  type: "new" as const,
                  projectId: null,
                  readOnly: false,
                  request: clause,
                  sources: [source(clause)],
                },
              ],
            };
          }
          return { requestId: snapshot.requestId, actions: [] };
        }),
      );
      yield* test.engine.observe(transcript(clause));
      const held = yield* test.engine.processLatest().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* test.engine.observe(
        transcript(`${clause} Nein, das war nur eine hypothetische Idee. Nicht ändern.`, 2),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      assert.equal(test.admitted.length, 0);
      assert.equal((yield* test.engine.state).reason, "source_revised");
      yield* test.engine.observe(
        transcript(
          "Wie viele Minuten hat eine Stunde? Wenn man das Menü löschen würde, wäre es leer, aber das möchte ich nicht.",
          3,
        ),
      );
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 0);
      const changed = setup((snapshot) =>
        Effect.succeed({
          requestId: snapshot.requestId,
          actions: snapshot.intents.length
            ? [
                {
                  type: "refine",
                  intentId: snapshot.intents[0]!.id,
                  readOnly: false,
                  message: "Korrektur: grüne Farben.",
                  sources: [source("Nein, lieber grüne Farben.", "correction")],
                },
              ]
            : [
                {
                  type: "new",
                  projectId: null,
                  readOnly: false,
                  request: "Menü blau gestalten.",
                  sources: [source("Gestalte das Menü blau.")],
                },
              ],
        }),
      );
      yield* changed.engine.observe(transcript("Gestalte das Menü blau."));
      yield* changed.engine.processLatest();
      yield* changed.engine.observe(
        transcript("Nein, lieber grüne Farben.", 1, false, "correction"),
      );
      yield* changed.engine.processLatest();
      assert.equal(changed.admitted.length, 1);
      assert.deepEqual(changed.steered, ["Korrektur: grüne Farben."]);
      yield* changed.engine.observe(
        transcript("Nein, lieber grüne Farben.", 2, true, "correction"),
      );
      yield* changed.engine.processLatest();
      assert.equal(changed.steered.length, 1);
    }),
);

it.effect(
  "promotes a provisional child on a complete nonfinal refinement, while confirm stays final-only",
  () =>
    Effect.gen(function* () {
      const research = "Inspect the selected button before changing it.";
      const authorize = "Yes, change the selected button to green now.";
      const test = setup((snapshot) => {
        const intent = snapshot.intents[0];
        const segment = snapshot.segments.at(-1)!;
        return Effect.succeed({
          requestId: snapshot.requestId,
          actions: intent
            ? [
                {
                  type: "confirm" as const,
                  intentId: intent.id,
                  sources: [source(authorize, segment.id, segment.revision)],
                },
                {
                  type: "refine" as const,
                  intentId: intent.id,
                  message: authorize,
                  readOnly: false,
                  sources: [source(authorize, segment.id, segment.revision)],
                },
              ]
            : [
                {
                  type: "new" as const,
                  projectId: null,
                  request: research,
                  readOnly: true,
                  sources: [source(research)],
                },
              ],
        });
      });
      yield* test.engine.observe(transcript(research));
      yield* test.engine.processLatest();
      const original = test.admitted[0]!;
      yield* test.engine.observe(transcript(authorize, 1, false, "authorization"));
      yield* test.engine.processLatest();
      assert.deepEqual(
        test.confirmed,
        [original.id],
        "only the authorized refinement promotes the child",
      );
      assert.deepEqual(test.steered, [authorize]);
      assert.equal(test.admitted.length, 1);
      const promoted = (yield* test.engine.state).intents[0]!;
      assert.equal(promoted.taskId, original.taskId);
      assert.equal(promoted.runId, original.runId);
      assert.isFalse(promoted.provisional);
      assert.isFalse(promoted.startedProvisional);
      yield* test.engine.observe(transcript(authorize, 2, true, "authorization"));
      yield* test.engine.processLatest();
      assert.deepEqual(test.steered, [authorize], "the later final cannot repeat the mutation");
    }),
);

it.effect("retains source-bound refinements while their exact run is preparing or queued", () =>
  Effect.gen(function* () {
    const first = "Add a search field.";
    const constraint = "Keep the keyboard shortcut.";
    const test = setup((snapshot) =>
      Effect.succeed({
        requestId: snapshot.requestId,
        actions: snapshot.intents.length
          ? [
              {
                type: "refine" as const,
                intentId: snapshot.intents[0]!.id,
                message: constraint,
                readOnly: false,
                sources: [source(constraint, "constraint")],
              },
            ]
          : [
              {
                type: "new" as const,
                projectId: null,
                request: first,
                readOnly: false,
                sources: [source(first)],
              },
            ],
      }),
    );
    yield* test.engine.observe(transcript(first));
    yield* test.engine.processLatest();
    test.setStatus("preparing");
    test.setPreviewContext("selected search field");
    yield* test.engine.observe(transcript(constraint, 1, false, "constraint"));
    yield* test.engine.processLatest();
    const pending = (yield* test.engine.state).intents[0]!.pendingSteer!;
    assert.equal(pending.message, constraint);
    assert.deepEqual(test.steered, []);
    test.setStatus("queued");
    yield* test.engine.processLatest();
    assert.equal((yield* test.engine.state).intents[0]!.pendingSteer!.requestId, pending.requestId);
    test.setStatus("running");
    test.setPreviewContext(null);
    yield* test.engine.processLatest();
    yield* test.engine.processLatest();
    assert.deepEqual(test.steered, [constraint]);
    assert.deepEqual(test.steeredContexts, ["selected search field"]);
    assert.isNull((yield* test.engine.state).intents[0]!.pendingSteer);
    assert.equal(test.admitted.length, 1);
  }),
);

it.effect("evicts old final paragraphs by text budget and rejects their in-flight decisions", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const old = "Add the original export button.";
    const late = "Add a compact search field.";
    let hold = false;
    const test = setup((snapshot) =>
      Effect.gen(function* () {
        if (hold) {
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(release);
        }
        const segment =
          snapshot.segments.find((s) => s.id === (hold ? "old" : "latest")) ??
          snapshot.segments.find((s) => s.id === "old");
        return {
          requestId: snapshot.requestId,
          actions: segment
            ? [
                {
                  type: "new" as const,
                  projectId: null,
                  request: segment.text,
                  readOnly: false,
                  sources: [source(segment.text, segment.id, segment.revision)],
                },
              ]
            : [],
        };
      }),
    );
    yield* test.engine.observe(transcript(old, 1, true, "old"));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 1);
    hold = true;
    yield* test.engine.observe(
      transcript("We are still discussing the layout.", 1, true, "discussion"),
    );
    const pending = yield* test.engine.processLatest().pipe(Effect.forkChild);
    yield* Deferred.await(held);
    for (let i = 0; i < 20; i++) {
      yield* test.engine.observe(
        transcript(
          `Completed discussion paragraph ${i}. ${"details ".repeat(110)}`,
          1,
          true,
          `paragraph-${i}`,
        ),
      );
    }
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pending);
    assert.equal(
      test.admitted.length,
      1,
      "an evicted exact source cannot dispatch its delayed decision",
    );
    assert.equal((yield* test.engine.state).reason, "source_revised");
    hold = false;
    yield* test.engine.observe(transcript(late, 1, false, "latest"));
    yield* test.engine.processLatest();
    assert.equal(
      test.admitted.length,
      2,
      "normal long conversation keeps accepting fresh short work",
    );
    assert.equal(test.admitted[1]!.request, late);
    yield* test.engine.observe(transcript(late, 2, true, "latest"));
    yield* test.engine.processLatest();
    assert.equal(test.admitted.length, 2, "neither old nor latest task is duplicated");
  }),
);

it.effect(
  "admits a fresh change to a completed result without replaying or refining the finished task",
  () =>
    Effect.gen(function* () {
      const first = "Set the heading to green.";
      const next = "Make that completed heading blue now.";
      const test = setup((snapshot) =>
        Effect.succeed({
          requestId: snapshot.requestId,
          actions: snapshot.intents.length
            ? [
                { type: "reference" as const, intentId: snapshot.intents[0]!.id },
                {
                  type: "new" as const,
                  projectId: null,
                  request: next,
                  readOnly: false,
                  sources: [source(next, "fresh-change")],
                },
              ]
            : [
                {
                  type: "new" as const,
                  projectId: null,
                  request: first,
                  readOnly: false,
                  sources: [source(first)],
                },
              ],
        }),
      );
      yield* test.engine.observe(transcript(first));
      yield* test.engine.processLatest();
      test.complete();
      yield* test.engine.observe(transcript(next, 1, false, "fresh-change"));
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 2);
      assert.equal(test.admitted[1]!.request, next);
      assert.notEqual(test.admitted[0]!.id, test.admitted[1]!.id);
      assert.equal(test.admitted[1]!.sources[0]!.segmentId, "fresh-change");
      assert.deepEqual(test.steered, []);
    }),
);

it.effect(
  "keeps active provisional and pending-steer sources while evicting final conversation history",
  () =>
    Effect.gen(function* () {
      const research = "Inspect the export form.";
      const constraint = "Read its validation rules too.";
      const test = setup((snapshot) =>
        Effect.succeed({
          requestId: snapshot.requestId,
          actions: snapshot.intents.length
            ? [
                {
                  type: "refine" as const,
                  intentId: snapshot.intents[0]!.id,
                  message: constraint,
                  readOnly: true,
                  sources: [source(constraint, "pending-source")],
                },
              ]
            : [
                {
                  type: "new" as const,
                  projectId: null,
                  request: research,
                  readOnly: true,
                  sources: [source(research)],
                },
              ],
        }),
      );
      yield* test.engine.observe(transcript(research));
      yield* test.engine.processLatest();
      const originalSources = test.admitted[0]!.sources;
      yield* test.engine.observe(transcript(research, 2, true));
      test.setStatus("preparing");
      yield* test.engine.observe(transcript(constraint, 1, true, "pending-source"));
      yield* test.engine.processLatest();
      const pending = (yield* test.engine.state).intents[0]!.pendingSteer!;
      for (let i = 0; i < 20; i++)
        yield* test.engine.observe(
          transcript(
            `Discussion paragraph ${i}. ${"details ".repeat(110)}`,
            1,
            true,
            `history-${i}`,
          ),
        );
      assert.isTrue(
        yield* test.engine.validateSources(originalSources),
        "active preliminary research retains its original source",
      );
      assert.isTrue(
        yield* test.engine.validateSources(pending.sources),
        "an unsent constraint retains its exact source",
      );
      test.setStatus("running");
      yield* test.engine.processLatest();
      assert.deepEqual(test.steered, [constraint]);
      assert.equal(test.admitted.length, 1);
      assert.equal((yield* test.engine.state).intents[0]!.taskId, test.admitted[0]!.taskId);
    }),
);
