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
  const steerKeys = new Set<string>();
  const attemptedSteerKeys: string[] = [];
  let loseReply = loseFirstSteerReply;
  let current = true;
  let completed = false;
  let stopId: string | null | undefined = null;
  const engine = makeVoiceIntake({
    leaseId: "lease",
    generation: 1,
    provisionalAllowed,
    decide,
    current: Effect.sync(() => current),
    stopId: Effect.sync(() => stopId),
    admit: (provenance, request) =>
      Effect.sync(() => {
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
        completed ? { ...intent, status: "completed", result: "Existing public result." } : intent,
      ),
    steer: (intent, message, requestId) =>
      Effect.gen(function* () {
        attemptedSteerKeys.push(requestId);
        if (!steerKeys.has(requestId)) {
          steerKeys.add(requestId);
          steered.push(message);
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
    steered,
    confirmed,
    attemptedSteerKeys,
    setCurrent: (value: boolean) => {
      current = value;
    },
    complete: () => {
      completed = true;
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
    yield* test.engine.observe(transcript(text, 2, true));
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

it.effect("defers preliminary mutations and ambiguous source identities", () =>
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
    assert.equal(test.admitted.length, 0);
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
