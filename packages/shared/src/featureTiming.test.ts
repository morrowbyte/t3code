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
