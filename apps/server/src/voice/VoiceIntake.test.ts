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
import {
  makeVoiceIntake,
  transferVoiceIntakeClaim,
  type VoiceIntakeDependencies,
} from "./VoiceIntake.ts";

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
  let beforeSteer: Effect.Effect<boolean> | undefined;
  let beforeConfirm: Effect.Effect<void> | undefined;
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
        if (beforeSteer && !(yield* beforeSteer))
          return { intent: { ...intent, status: status ?? intent.status }, delivered: false };
        if (!steerKeys.has(requestId)) {
          steerKeys.add(requestId);
          steered.push(message);
          steeredContexts.push(context);
        }
        if (loseReply) {
          loseReply = false;
          return yield* new LiveVoiceError({ code: "runtime_unavailable" });
        }
        return { intent, delivered: true };
      }),
    confirm: (intent) =>
      Effect.gen(function* () {
        if (beforeConfirm) yield* beforeConfirm;
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
    setBeforeSteer: (value: Effect.Effect<boolean> | undefined) => {
      beforeSteer = value;
    },
    setBeforeConfirm: (value: Effect.Effect<void>) => {
      beforeConfirm = value;
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

it.effect.each([null, "a", "b"] as const)(
  "retains queued refinements A+B with separate sources and preview contexts (corrected: %s)",
  (corrected) =>
    Effect.gen(function* () {
      const first = "Add the settings form.";
      const constraints = {
        a: "Keep the submit label.",
        b: "Announce successful submission to screen readers.",
      };
      const test = setup((snapshot) => {
        const segment = snapshot.segments.at(-1)!;
        return Effect.succeed({
          requestId: snapshot.requestId,
          actions:
            snapshot.intents.length === 0
              ? [
                  {
                    type: "new" as const,
                    projectId: null,
                    request: first,
                    readOnly: false,
                    sources: [source(first)],
                  },
                ]
              : segment.revision === 1 && (segment.id === "a" || segment.id === "b")
                ? [
                    {
                      type: "refine" as const,
                      intentId: snapshot.intents[0]!.id,
                      message: segment.text,
                      readOnly: false,
                      sources: [source(segment.text, segment.id)],
                    },
                  ]
                : [],
        });
      });
      yield* test.engine.observe(transcript(first));
      yield* test.engine.processLatest();
      const original = test.admitted[0]!;
      test.setStatus("preparing");
      test.setPreviewContext("selection A");
      yield* test.engine.observe(transcript(constraints.a, 1, true, "a"));
      yield* test.engine.processLatest();
      test.setStatus("queued");
      test.setPreviewContext("selection B");
      yield* test.engine.observe(transcript(constraints.b, 1, true, "b"));
      yield* test.engine.processLatest();
      const intent = (yield* test.engine.state).intents[0]!;
      const queued = [intent.pendingSteer!, ...intent.queuedSteers!];
      assert.deepEqual(
        queued.map((pending) => pending.message),
        [constraints.a, constraints.b],
      );
      assert.deepEqual(
        queued.map((pending) => pending.previewContext),
        ["selection A", "selection B"],
      );
      assert.notEqual(queued[0]!.requestId, queued[1]!.requestId);
      if (corrected)
        yield* test.engine.observe(transcript("This source was replaced.", 2, true, corrected));
      // Budget eviction must protect both the head and the subsequent source.
      for (let i = 0; i < 20; i++)
        yield* test.engine.observe(
          transcript(
            `Completed discussion ${i}. ${"details ".repeat(110)}`,
            1,
            true,
            `queued-history-${i}`,
          ),
        );
      test.setStatus("running");
      test.setPreviewContext("new unrelated selection");
      yield* test.engine.processLatest();
      yield* test.engine.processLatest();
      const expected = ["a", "b"].filter((id) => id !== corrected) as Array<"a" | "b">;
      assert.deepEqual(
        test.steered,
        expected.map((id) => constraints[id]),
      );
      assert.deepEqual(
        test.steeredContexts,
        expected.map((id) => `selection ${id.toUpperCase()}`),
      );
      assert.deepEqual(
        test.attemptedSteerKeys,
        queued
          .filter((pending) => pending.sources[0]!.segmentId !== corrected)
          .map((pending) => pending.requestId),
      );
      const completed = (yield* test.engine.state).intents[0]!;
      assert.equal(completed.runId, original.runId);
      assert.equal(completed.taskId, original.taskId);
      assert.isNull(completed.pendingSteer);
      assert.deepEqual(completed.queuedSteers, []);
      assert.equal(test.admitted.length, 1);
    }),
);

it.effect(
  "recovers a lost reply for queued A before delivering B once under its own idempotency key",
  () =>
    Effect.gen(function* () {
      const test = setup(
        (snapshot) => {
          const segment = snapshot.segments.at(-1)!;
          return Effect.succeed({
            requestId: snapshot.requestId,
            actions: snapshot.intents.length
              ? [
                  {
                    type: "refine" as const,
                    intentId: snapshot.intents[0]!.id,
                    message: segment.text,
                    readOnly: false,
                    sources: [source(segment.text, segment.id)],
                  },
                ]
              : [
                  {
                    type: "new" as const,
                    projectId: null,
                    request: segment.text,
                    readOnly: false,
                    sources: [source(segment.text)],
                  },
                ],
          });
        },
        true,
        true,
      );
      yield* test.engine.observe(transcript("Add the form."));
      yield* test.engine.processLatest();
      test.setStatus("preparing");
      yield* test.engine.observe(transcript("Retain the label.", 1, false, "a"));
      yield* test.engine.processLatest();
      yield* test.engine.observe(transcript("Announce submission.", 1, false, "b"));
      yield* test.engine.processLatest();
      const queued = (yield* test.engine.state).intents[0]!;
      const a = queued.pendingSteer!.requestId;
      const b = queued.queuedSteers![0]!.requestId;
      test.setStatus("running");
      assert.isTrue((yield* test.engine.processLatest().pipe(Effect.exit))._tag === "Failure");
      assert.equal((yield* test.engine.state).intents[0]!.pendingSteer!.requestId, a);
      yield* test.engine.processLatest();
      yield* test.engine.processLatest();
      assert.deepEqual(test.attemptedSteerKeys, [a, a, b]);
      assert.deepEqual(test.steered, ["Retain the label.", "Announce submission."]);
      assert.isNull((yield* test.engine.state).intents[0]!.pendingSteer);
    }),
);

it.effect(
  "deduplicates smaller quotes and unions of claimed ranges while allowing an appended requirement",
  () =>
    Effect.gen(function* () {
      const first = "Keep the label. Preserve focus.";
      const appended = " Announce Sent to screen readers.";
      let round = 0;
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
                    readOnly: false,
                    sources: [
                      source("Keep the label.", "segment-a", 1, 0),
                      source(" Preserve focus.", "segment-a", 1, 15),
                    ],
                  },
                ]
              : [
                  {
                    type: "refine" as const,
                    intentId: snapshot.intents[0]!.id,
                    message:
                      round < 4 ? "Paraphrase the existing label and focus request." : appended,
                    readOnly: false,
                    sources: [
                      round === 2
                        ? source("the label.", "segment-a", 2, 5)
                        : round === 3
                          ? source(first, "segment-a", 3)
                          : source(
                              appended,
                              "segment-a",
                              snapshot.segments[0]!.revision,
                              first.length,
                            ),
                    ],
                  },
                ],
        }),
      );
      yield* test.engine.observe(transcript(first));
      yield* test.engine.processLatest();
      yield* test.engine.observe(transcript(first, 2));
      yield* test.engine.processLatest();
      yield* test.engine.observe(transcript(first, 3));
      yield* test.engine.processLatest();
      assert.deepEqual(
        test.steered,
        [],
        "claimed interval union covers both small and expanded quotes",
      );
      yield* test.engine.observe(transcript(first + appended, 4));
      yield* test.engine.processLatest();
      yield* test.engine.observe(transcript(first + appended, 5, true));
      yield* test.engine.processLatest();
      assert.deepEqual(test.steered, [appended]);
      assert.equal(test.admitted.length, 1);
    }),
);

it.effect.each(["starting", "waiting"])(
  "retains the same FIFO key across a running to %s race",
  (unavailable) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = "Add a form.";
      const next = "Announce Sent to screen readers.";
      const test = setup((snapshot) =>
        Effect.succeed({
          requestId: snapshot.requestId,
          actions: snapshot.intents.length
            ? [
                {
                  type: "refine" as const,
                  intentId: snapshot.intents[0]!.id,
                  message: next,
                  readOnly: false,
                  sources: [source(next, "next")],
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
      test.setStatus(unavailable);
      yield* test.engine.observe(transcript(next, 1, false, "next"));
      yield* test.engine.processLatest();
      assert.deepEqual(test.attemptedSteerKeys, [], "only running is steerable");
      const key = (yield* test.engine.state).intents[0]!.pendingSteer!.requestId;
      test.setStatus("running");
      test.setBeforeSteer(
        Effect.gen(function* () {
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(release);
          return false;
        }),
      );
      const delivery = yield* test.engine.processLatest().pipe(Effect.forkChild);
      yield* Deferred.await(held);
      test.setStatus(unavailable);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(delivery);
      assert.equal((yield* test.engine.state).intents[0]!.pendingSteer!.requestId, key);
      test.setBeforeSteer(undefined);
      test.setStatus("running");
      yield* test.engine.processLatest();
      yield* test.engine.processLatest();
      assert.deepEqual(test.attemptedSteerKeys, [key, key]);
      assert.deepEqual(test.steered, [next]);
      assert.isNull((yield* test.engine.state).intents[0]!.pendingSteer);
    }),
);

it.effect.each(["new", "reference", "refine"] as const)(
  "rechecks an active-to-completed decision once before accepting %s",
  (answer) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = "Add the form with the Ready state.";
      const next = "After sending, show Sent, reset the form and announce Sent to screen readers.";
      let decisions = 0;
      const test = setup((snapshot) =>
        Effect.gen(function* () {
          decisions++;
          const owner = snapshot.intents[0];
          if (!owner)
            return {
              requestId: snapshot.requestId,
              actions: [
                {
                  type: "new" as const,
                  projectId: null,
                  request: first,
                  readOnly: false,
                  sources: [source(first)],
                },
              ],
            };
          if (owner.status !== "completed") {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            return {
              requestId: snapshot.requestId,
              actions: [
                {
                  type: "refine" as const,
                  intentId: owner.id,
                  message: next,
                  readOnly: false,
                  sources: [source(next, "next")],
                },
              ],
            };
          }
          assert.equal(owner.result, "Existing public result.");
          assert.isFalse(
            owner.sources.some((source) => source.segmentId === "next"),
            "unhandled pending sources remain candidates for semantic reconsideration",
          );
          return {
            requestId: snapshot.requestId,
            actions:
              answer === "new"
                ? [
                    {
                      type: "new" as const,
                      projectId: null,
                      request: next,
                      readOnly: false,
                      sources: [source(next, "next")],
                    },
                  ]
                : answer === "reference"
                  ? [{ type: "reference" as const, intentId: owner.id }]
                  : [
                      {
                        type: "refine" as const,
                        intentId: owner.id,
                        message: next,
                        readOnly: false,
                        sources: [source(next, "next")],
                      },
                    ],
          };
        }),
      );
      yield* test.engine.observe(transcript(first));
      yield* test.engine.processLatest();
      test.setPreviewContext("selected form before completion");
      yield* test.engine.observe(transcript(next, 1, false, "next"));
      const deciding = yield* test.engine.processLatest().pipe(Effect.forkChild);
      yield* Deferred.await(held);
      test.complete();
      test.setPreviewContext("different selection");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(deciding);
      assert.equal(test.admitted.length, 1, "an active snapshot never blindly becomes new work");
      yield* test.engine.processLatest();
      yield* test.engine.processLatest();
      assert.equal(decisions, 3, "exactly one semantic recheck with the actual result");
      assert.deepEqual(test.steered, []);
      assert.equal(test.admitted.length, answer === "new" ? 2 : 1);
      if (answer === "new") {
        assert.equal(test.admitted[1]!.request, next);
        assert.equal(test.admittedContexts[1], "selected form before completion");
        assert.deepEqual(
          (yield* test.engine.state).intents[0]!.claimedSources.map((s) => s.quote),
          [first],
        );
      } else if (answer === "refine") {
        assert.equal((yield* test.engine.state).reason, "task_finished_requires_new_request");
      }
    }),
);

it.effect(
  "transfers both unhandled FIFO entries after completion with their own frozen selection",
  () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = "Add the form.";
      const parts = ["Show Sent then reset.", "Announce Sent to screen readers."];
      let classify = 0;
      const test = setup((snapshot) =>
        Effect.gen(function* () {
          classify++;
          if (!snapshot.intents.length)
            return {
              requestId: snapshot.requestId,
              actions: [
                {
                  type: "new" as const,
                  projectId: null,
                  request: first,
                  readOnly: false,
                  sources: [source(first)],
                },
              ],
            };
          if (snapshot.intents[0]!.status === "completed") {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            return {
              requestId: snapshot.requestId,
              actions: parts.map((text, index) => ({
                type: "new" as const,
                projectId: null,
                request: text,
                readOnly: false,
                sources: [source(text, `part-${index}`)],
              })),
            };
          }
          const index = classify - 2;
          return {
            requestId: snapshot.requestId,
            actions: [
              {
                type: "refine" as const,
                intentId: snapshot.intents[0]!.id,
                message: parts[index]!,
                readOnly: false,
                sources: [source(parts[index]!, `part-${index}`)],
              },
            ],
          };
        }),
      );
      yield* test.engine.observe(transcript(first));
      yield* test.engine.processLatest();
      test.setStatus("preparing");
      for (const [index, part] of parts.entries()) {
        test.setPreviewContext(`selection ${index}`);
        yield* test.engine.observe(transcript(part, 1, false, `part-${index}`));
        yield* test.engine.processLatest();
      }
      assert.equal((yield* test.engine.state).intents[0]!.queuedSteers!.length, 1);
      test.complete();
      const recheck = yield* test.engine.processLatest().pipe(Effect.forkChild);
      yield* Deferred.await(held);
      test.setPreviewContext("unrelated selection");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(recheck);
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 3);
      assert.deepEqual(test.admittedContexts, [null, "selection 0", "selection 1"]);
      assert.deepEqual(test.steered, []);
      const old = (yield* test.engine.state).intents[0]!;
      assert.isNull(old.pendingSteer);
      assert.deepEqual(
        old.claimedSources.map((s) => s.quote),
        [first],
      );
      assert.isUndefined(transferVoiceIntakeClaim(old, "absent", [source(parts[0]!, "part-0")]));
    }),
);

it.effect(
  "preserves implementation when provisional research ends inside confirm before refine",
  () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const research = "Research the form accessibility.";
      const change = "Implement the screen reader announcement now.";
      const test = setup((snapshot) => {
        const owner = snapshot.intents[0];
        return Effect.succeed({
          requestId: snapshot.requestId,
          actions: !owner
            ? [
                {
                  type: "new" as const,
                  projectId: null,
                  request: research,
                  readOnly: true,
                  sources: [source(research)],
                },
              ]
            : owner.status === "completed"
              ? [
                  {
                    type: "new" as const,
                    projectId: null,
                    request: change,
                    readOnly: false,
                    sources: [source(change, "confirm", 1)],
                  },
                ]
              : [
                  {
                    type: "confirm" as const,
                    intentId: owner.id,
                    sources: [source(change, "confirm", 1)],
                  },
                  {
                    type: "refine" as const,
                    intentId: owner.id,
                    message: change,
                    readOnly: false,
                    sources: [source(change, "confirm", 1)],
                  },
                ],
        });
      });
      yield* test.engine.observe(transcript(research));
      yield* test.engine.processLatest();
      test.setBeforeConfirm(
        Effect.gen(function* () {
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(release);
        }),
      );
      yield* test.engine.observe(transcript(change, 1, true, "confirm"));
      const confirming = yield* test.engine.processLatest().pipe(Effect.forkChild);
      yield* Deferred.await(held);
      test.complete();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(confirming);
      assert.equal(test.admitted.length, 1);
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 2);
      assert.isFalse(test.admitted[1]!.provisional);
      assert.deepEqual(
        test.admitted[1]!.sources.map((s) => s.quote),
        [change],
      );
      assert.deepEqual(test.steered, []);
      yield* test.engine.processLatest();
      assert.equal(test.admitted.length, 2);
    }),
);

it.effect("a final confirm alone cannot turn completed research into mutation", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const text = "Research the form.";
    const confirm = "Yes, that research is confirmed.";
    const test = setup((snapshot) =>
      Effect.gen(function* () {
        if (!snapshot.intents.length)
          return {
            requestId: snapshot.requestId,
            actions: [
              {
                type: "new" as const,
                projectId: null,
                request: text,
                readOnly: true,
                sources: [source(text)],
              },
            ],
          };
        yield* Deferred.succeed(held, undefined);
        yield* Deferred.await(release);
        return {
          requestId: snapshot.requestId,
          actions: [
            {
              type: "confirm" as const,
              intentId: snapshot.intents[0]!.id,
              sources: [source(confirm, "confirm")],
            },
          ],
        };
      }),
    );
    yield* test.engine.observe(transcript(text));
    yield* test.engine.processLatest();
    yield* test.engine.observe(transcript(confirm, 1, true, "confirm"));
    const deciding = yield* test.engine.processLatest().pipe(Effect.forkChild);
    yield* Deferred.await(held);
    test.complete();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(deciding);
    assert.equal(test.admitted.length, 1);
    assert.deepEqual(test.confirmed, []);
    assert.deepEqual(
      (yield* test.engine.state).intents[0]!.claimedSources.map((s) => s.quote),
      [text],
    );
  }),
);

it.effect(
  "bounds quoted snapshot ownership to visible matching speech while retaining durable history",
  () =>
    Effect.gen(function* () {
      const snapshots: Array<Parameters<VoiceIntakeDependencies["decide"]>[0]> = [];
      const first = "Add an export control.";
      const test = setup((snapshot) => {
        snapshots.push(snapshot);
        return Effect.succeed({
          requestId: snapshot.requestId,
          actions: snapshot.intents.length
            ? []
            : [
                {
                  type: "new" as const,
                  projectId: null,
                  request: first,
                  readOnly: false,
                  sources: [source(first), source(first)],
                },
              ],
        });
      });
      yield* test.engine.observe(transcript(first, 1, true));
      yield* test.engine.processLatest();
      yield* test.engine.observe(transcript(`${first} Additional discussion.`, 2, true));
      yield* test.engine.processLatest();
      assert.equal(
        snapshots.at(-1)!.intents[0]!.sources.length,
        1,
        "exact duplicate quotes appear once",
      );
      assert.equal(
        snapshots.at(-1)!.intents[0]!.sources[0]!.quote,
        first,
        "unchanged old revision quotes remain useful",
      );
      yield* test.engine.observe(transcript("The export request was replaced.", 3, true));
      yield* test.engine.processLatest();
      assert.deepEqual(
        snapshots.at(-1)!.intents[0]!.sources,
        [],
        "a replaced quote is never subtracted from candidates",
      );
      for (let i = 0; i < 24; i++) {
        yield* test.engine.observe(
          transcript(`Discussion ${i}. ${"details ".repeat(100)}`, 1, true, `history-window-${i}`),
        );
        yield* test.engine.processLatest();
      }
      const latest = snapshots.at(-1)!;
      assert.equal(latest.segments.length, 12);
      assert.deepEqual(latest.intents[0]!.sources, []);
      assert.equal(latest.intents[0]!.request, first);
      assert.isBelow(
        JSON.stringify(latest).length,
        16_000,
        "historical quotes cannot grow the bounded live prompt",
      );
      assert.equal(
        (yield* test.engine.state).intents[0]!.claimedSources.length,
        2,
        "durable ownership is complete",
      );
    }),
);
