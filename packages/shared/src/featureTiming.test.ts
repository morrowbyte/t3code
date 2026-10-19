import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ThreadId,
  MessageId,
  type FeatureTimingFact,
  type FeatureTimingRecord,
  type ProjectFeatureTimingHistory,
} from "@t3tools/contracts";
import {
  projectFeatureTiming,
  unionDuration,
  validateFeatureTimingRecords,
} from "./featureTiming.ts";

const at = (hours: number) => `2026-10-17T${String(hours).padStart(2, "0")}:00:00.000Z`;
const record = (sequence: number, hour: number, fact: FeatureTimingFact): FeatureTimingRecord => ({
  sequence,
  at: at(hour),
  fact,
});
const threadId = ThreadId.make("thread:feature");
const registration = record(1, 1, {
  type: "registered",
  featureId: "feature",
  title: "Useful feature",
  intake: null,
  originalEstimate: null,
  threadIds: [threadId],
  targets: [
    { id: "laptop", label: "Laptop" },
    { id: "remote", label: "Remote" },
  ],
});
const feed = (records: FeatureTimingRecord[]): ProjectFeatureTimingHistory => ({
  projectId: ProjectId.make("project"),
  asOf: at(12),
  coverage: "complete",
  records,
  observations: [
    {
      threadId,
      runs: [{ id: "run", requestedAt: at(1), startedAt: at(2), end: at(3), status: "completed" }],
      waits: [],
    },
  ],
});
const accept = (
  sequence: number,
  hour: number,
  targetId: string,
  version: string,
): FeatureTimingRecord => ({
  ...record(sequence, hour, {
    type: "target_accepted",
    featureId: "feature",
    targetId,
    version,
    evidence: { threadId, messageId: MessageId.make(`message:${sequence}`) },
  }),
  userEvidence: { actor: "user", at: at(hour), source: "web" },
});

describe("feature timing", () => {
  it("summarizes unique completed run durations, scoped to linked threads", () => {
    const input = feed([registration]);
    const run = input.observations[0]!.runs[0]!;
    const observations = [
      {
        threadId,
        waits: [],
        runs: [
          run,
          { ...run },
          { ...run, id: "short", end: at(2) },
          { ...run, id: "long", end: at(5) },
        ],
      },
      { threadId, runs: [{ ...run }], waits: [] },
      { threadId: ThreadId.make("unlinked"), runs: [{ ...run, end: at(11) }], waits: [] },
    ];
    expect(projectFeatureTiming({ ...input, observations })[0]?.observedRunTiming).toEqual({
      sampleSize: 3,
      minimumMs: 0,
      medianMs: 3_600_000,
      maximumMs: 3 * 3_600_000,
    });
    const pair = [{ threadId, runs: [run, { ...run, id: "second", end: at(4) }], waits: [] }];
    expect(
      projectFeatureTiming({ ...input, observations: pair })[0]?.observedRunTiming?.medianMs,
    ).toBe(1.5 * 3_600_000);
    const records = [
      ...input.records,
      record(2, 3, {
        type: "thread_linked",
        featureId: "feature",
        threadId: ThreadId.make("linked"),
      }),
    ];
    expect(
      projectFeatureTiming({
        ...input,
        records,
        observations: [...pair, { threadId: ThreadId.make("linked"), runs: [run], waits: [] }],
      })[0]?.observedRunTiming?.sampleSize,
    ).toBe(3);
  });

  it("excludes unfinished, unsuccessful, invalid and conflicting runs in either order", () => {
    const input = feed([registration]);
    const run = input.observations[0]!.runs[0]!;
    const invalid = [
      ...["running", "waiting", "failed", "cancelled", "interrupted", "rolled_back"].map(
        (status) => ({ ...run, id: status, status }),
      ),
      { ...run, id: "missing-start", startedAt: null },
      { ...run, id: "missing-end", end: null },
      { ...run, id: "invalid-start", startedAt: "invalid" },
      { ...run, id: "invalid-end", end: "invalid" },
      { ...run, id: "invalid-request", requestedAt: "invalid" },
      { ...run, id: "reverse", end: at(1) },
      { ...run, id: "before-request", requestedAt: at(4) },
      { ...run, id: "future", end: at(13) },
      { ...run, id: "conflict" },
      { ...run, id: "conflict", status: "failed" },
      { ...run, id: "conflict" },
      { ...run, id: "time-conflict" },
      { ...run, id: "time-conflict", end: at(4) },
    ];
    for (const runs of [invalid, invalid.toReversed()]) {
      const observed = { ...input, observations: [{ threadId, runs, waits: [] }] };
      expect(projectFeatureTiming(observed)[0]?.observedRunTiming).toBeNull();
      expect(
        projectFeatureTiming({
          ...observed,
          observations: [{ threadId, runs: [...runs, run], waits: [] }],
        })[0]?.observedRunTiming,
      ).toMatchObject({
        sampleSize: 1,
        medianMs: 3_600_000,
      });
    }
  });

  it("keeps missing or incomplete history unavailable rather than manufacturing a sample", () => {
    for (const coverage of ["unavailable", "incomplete", "no_feature_history"] as const) {
      expect(
        projectFeatureTiming({ ...feed([registration]), coverage })[0]?.observedRunTiming,
      ).toBeNull();
    }
    expect(
      projectFeatureTiming({ ...feed([registration]), observations: [] })[0]?.observedRunTiming,
    ).toBeNull();
    expect(
      projectFeatureTiming({ ...feed([registration]), asOf: "invalid" })[0]?.observedRunTiming,
    ).toBeNull();
  });

  it("unions nested, simultaneous and adjacent waits without double counting", () => {
    expect(
      unionDuration([
        [1, 10],
        [2, 3],
        [6, 12],
        [12, 14],
        [20, 19],
      ]),
    ).toBe(13);
    const input = feed([
      registration,
      record(2, 3, {
        type: "wait_started",
        featureId: "feature",
        waitId: "build",
        reason: "build",
      }),
      record(3, 4, {
        type: "wait_started",
        featureId: "feature",
        waitId: "review",
        reason: "review",
      }),
      record(4, 7, { type: "wait_ended", featureId: "feature", waitId: "build" }),
      record(5, 8, { type: "wait_ended", featureId: "feature", waitId: "review" }),
    ]);
    const observed = {
      ...input,
      observations: [
        {
          threadId,
          runs: [],
          waits: [{ id: "request", start: at(5), end: at(9), reason: "user" }],
        },
      ],
    };
    expect(projectFeatureTiming(observed)[0]?.waitMs).toBe(6 * 3_600_000);
  });

  it("retains the initial intake and per-target version through reopen and later acceptance", () => {
    const input = feed([
      { ...registration, userEvidence: { actor: "user", at: at(0), source: "mobile" } },
      accept(2, 4, "laptop", ".42"),
      accept(3, 5, "remote", ".42"),
      record(4, 6, {
        type: "target_reopened",
        featureId: "feature",
        targetId: "laptop",
        reason: "Unavailable on laptop",
      }),
    ]);
    const reopened = projectFeatureTiming(input)[0]!;
    expect(reopened).toMatchObject({
      state: "reopened",
      reopenCount: 1,
      elapsedFromIntakeMs: 12 * 3_600_000,
      firstAcceptedAt: Date.parse(at(4)),
      latestCompletionAt: Date.parse(at(5)),
    });
    expect(reopened.targets).toMatchObject([
      { acceptedVersion: ".42", reopened: true },
      { acceptedVersion: ".42", reopened: false },
    ]);
    const completed = projectFeatureTiming({
      ...input,
      records: [...input.records, accept(5, 10, "laptop", ".43")],
    })[0]!;
    expect(completed).toMatchObject({
      state: "accepted",
      elapsedFromIntakeMs: 10 * 3_600_000,
      elapsedFromWorkMs: 8 * 3_600_000,
      firstAcceptedAt: Date.parse(at(4)),
      latestCompletionAt: Date.parse(at(10)),
    });
  });

  it("does not turn a completed run or missing start into an estimate, intake or acceptance", () => {
    const result = projectFeatureTiming(feed([registration]))[0]!;
    expect(result).toMatchObject({
      originalEstimate: null,
      intakeAt: null,
      elapsedFromIntakeMs: null,
      firstAcceptedAt: null,
      state: "in_development",
      phases: [],
    });
    expect(result.targets.every((t) => t.acceptedVersion === null)).toBe(true);
    const unknown = projectFeatureTiming({ ...feed([registration]), observations: [] })[0]!;
    expect(unknown.workStartedAt).toBeNull();
    expect(unknown.elapsedFromWorkMs).toBeNull();
  });

  it("rejects duplicate registration, orphan waits and unknown targets", () => {
    expect(validateFeatureTimingRecords([registration, { ...registration, sequence: 2 }])).toBe(
      false,
    );
    expect(
      validateFeatureTimingRecords([
        registration,
        record(2, 3, { type: "wait_ended", featureId: "feature", waitId: "missing" }),
      ]),
    ).toBe(false);
    expect(validateFeatureTimingRecords([registration, accept(2, 4, "unknown", ".42")])).toBe(
      false,
    );
  });
});
