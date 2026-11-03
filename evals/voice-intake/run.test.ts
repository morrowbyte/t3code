import { describe, expect, it } from "vite-plus/test";
import type { VoiceIntakeDecision } from "../../packages/contracts/src/voiceIntake.ts";
import { caseForSample, cases, snapshotFor } from "./cases.ts";
import { grade } from "./grade.ts";

describe("native intake grading", () => {
  it("carries assistant context while grading authorization only against fresh user speech", () => {
    const original = cases.find((item) => item.id === "assistant-proposal-contextual-refinement")!;
    const testCase = caseForSample(original, "context-sample");
    const snapshot = snapshotFor(testCase, "lease", 2);
    expect(snapshot.conversationContext).toBe(original.conversationContext);
    const acceptance = snapshot.segments[1]!;
    const action = {
      type: "refine" as const,
      intentId: testCase.intents[0]!.id,
      readOnly: false,
      message: "Ändere die Überschrift auf Team-Puls.",
      sources: [
        { segmentId: acceptance.id, revision: acceptance.revision, quote: acceptance.text },
      ],
    };
    expect(
      grade(testCase, snapshot, { requestId: snapshot.requestId, actions: [action] }).pass,
    ).toBe(true);
    expect(
      grade(testCase, snapshot, {
        requestId: snapshot.requestId,
        actions: [
          {
            ...action,
            sources: [{ segmentId: "assistant-proposal", revision: 1, quote: "Team-Puls" }],
          },
        ],
      }).failures,
    ).toContain("source_identity");
  });

  it("recognizes the native no-files wording while rejecting a missing constraint", () => {
    const original = cases.find((item) => item.id === "rejected-chart-keeps-current-constraint")!;
    const testCase = caseForSample(original, "rejected-sample");
    const snapshot = snapshotFor(testCase, "lease", 2);
    const action = {
      type: "new" as const,
      projectId: "project-alpha",
      readOnly: false,
      request:
        "Create a bar chart in this chat: Monday 8, Tuesday 3, Wednesday 2. Do not modify files.",
      sources: snapshot.segments.map((segment) => ({
        segmentId: segment.id,
        revision: segment.revision,
        quote: segment.text,
      })),
    };
    expect(snapshot.rejections![0]!.sources[0]!.segmentId).toBe(snapshot.segments[0]!.id);
    expect(
      grade(testCase, snapshot, { requestId: snapshot.requestId, actions: [action] }).pass,
    ).toBe(true);
    expect(
      grade(testCase, snapshot, {
        requestId: snapshot.requestId,
        actions: [
          {
            ...action,
            request: "Create a bar chart in this chat: Monday 8, Tuesday 3, Wednesday 2.",
          },
        ],
      }).pass,
    ).toBe(false);
  });

  it.each([cases[1]!, cases[5]!])("remaps $id and its expected target together", (original) => {
    const first = caseForSample(original, "sample-1");
    const second = caseForSample(original, "sample-2");
    expect(first.intents[0]!.id).not.toBe(original.intents[0]!.id);
    expect(first.intents[0]!.id).not.toBe(second.intents[0]!.id);
    expect(first.expected.intentId).toBe(first.intents[0]!.id);
    expect(second.expected.intentId).toBe(second.intents[0]!.id);
    expect(first.segments.map((segment) => segment.id)).not.toEqual(
      second.segments.map((segment) => segment.id),
    );
    expect(first.segments.map(({ id: _id, ...segment }) => segment)).toEqual(
      original.segments.map(({ id: _id, ...segment }) => segment),
    );
    expect(first.rubric).toBe(original.rubric);
    expect(first.expected.required).toEqual(original.expected.required);
    expect(first.expected.forbidden).toEqual(original.expected.forbidden);
  });

  it("keeps remapped intent provenance claimed and rejects stale sample identities", () => {
    const original = cases[1]!;
    const testCase = caseForSample(original, "sample-1");
    const snapshot = snapshotFor(testCase, "test-lease", 1);
    const old = snapshot.segments[0]!;
    const correction = snapshot.segments[1]!;
    expect(testCase.intents[0]!.sources).toEqual([
      { ...original.intents[0]!.sources[0]!, segmentId: old.id },
    ]);
    const action = {
      type: "refine" as const,
      intentId: testCase.intents[0]!.id,
      readOnly: false,
      message: "Ergänze ein Balkendiagramm mit drei Tageswerten.",
      sources: [
        { segmentId: correction.id, revision: correction.revision, quote: correction.text },
      ],
    };
    const decision: VoiceIntakeDecision = { requestId: snapshot.requestId, actions: [action] };
    expect(grade(testCase, snapshot, decision).pass).toBe(true);
    expect(
      grade(testCase, snapshot, {
        ...decision,
        actions: [{ ...action, intentId: original.intents[0]!.id }],
      }).failures,
    ).toContain("intent_identity");
    expect(
      grade(testCase, snapshot, {
        ...decision,
        actions: [
          { ...action, sources: [{ ...action.sources[0]!, segmentId: original.segments[1]!.id }] },
        ],
      }).failures,
    ).toContain("source_identity");
    expect(
      grade(testCase, snapshot, {
        ...decision,
        actions: [
          { ...action, sources: [{ segmentId: old.id, revision: old.revision, quote: old.text }] },
        ],
      }).failures,
    ).toContain("source_already_claimed");
  });

  it.each([
    ["exact source", "exact", true],
    ["changed quote", "quote", false],
    ["stale revision", "revision", false],
    ["unknown segment", "segment", false],
    ["negated project", "project", false],
    ["duplicate admission", "duplicate", false],
    ["wrong write permission", "permission", false],
    ["ambiguous repeated quote", "ambiguous", false],
    ["German passend is not sending", "passend", true],
    ["English send remains forbidden", "send", false],
    ["German senden remains forbidden", "senden", false],
  ] as const)("%s", (_name, change, pass) => {
    const testCase = cases[0]!;
    const original = snapshotFor(testCase, "test-lease", 1);
    const segment = original.segments[0]!;
    const quote = segment.text.split(" Und wenn")[0]!;
    const snapshot =
      change === "ambiguous"
        ? { ...original, segments: [{ ...segment, text: `${quote} ${quote}` }] }
        : original;
    const action = {
      type: "new" as const,
      sources: [
        {
          segmentId: change === "segment" ? "missing" : segment.id,
          revision: change === "revision" ? 1 : segment.revision,
          quote: change === "quote" ? "Ein erfundenes Zitat" : quote,
        },
      ],
      request: `Erstelle ein Markdown-Dokument mit einem Rustlings-Lernplan für drei Übungseinheiten.${
        change === "passend"
          ? " Formuliere die Lernziele passend für Anfänger."
          : change === "send"
            ? " Send it to my manager."
            : change === "senden"
              ? " An meinen Chef senden."
              : ""
      }`,
      projectId: change === "project" ? "project-beta" : null,
      readOnly: change === "permission",
    };
    const decision: VoiceIntakeDecision = {
      requestId: snapshot.requestId,
      actions: change === "duplicate" ? [action, action] : [action],
    };
    expect(grade(testCase, snapshot, decision).pass).toBe(pass);
  });

  it("rejects reusing already claimed speech for a correction", () => {
    const testCase = cases[1]!;
    const snapshot = snapshotFor(testCase, "test-lease", 1);
    const old = snapshot.segments[0]!;
    const decision: VoiceIntakeDecision = {
      requestId: snapshot.requestId,
      actions: [
        {
          type: "refine",
          intentId: "report-running",
          readOnly: false,
          message: "Ergänze ein Balkendiagramm mit drei Tageswerten.",
          sources: [{ segmentId: old.id, revision: old.revision, quote: old.text }],
        },
      ],
    };
    expect(grade(testCase, snapshot, decision).failures).toContain("source_already_claimed");
  });
});
