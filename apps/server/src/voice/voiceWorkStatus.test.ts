import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { voiceRunStatus } from "./voiceWorkStatus.ts";

const now = DateTime.makeUnsafe("2026-10-23T15:00:00Z");
function fixture() {
  return {
    runs: [
      {
        id: "run",
        threadId: "thread",
        ordinal: 6,
        status: "running",
        activeAttemptId: "attempt",
        userMessageId: "request",
        modelSelection: { model: "test" },
        requestedAt: now,
      },
    ],
    attempts: [{ id: "attempt" }],
    providerTurns: [{ id: "turn", runAttemptId: "attempt", ordinal: 1, status: "running" }],
    messages: [{ id: "request", threadId: "thread", role: "user", text: "Prüfe Voice-Status" }],
    turnItems: [
      {
        id: "plan",
        threadId: "thread",
        runId: "run",
        providerTurnId: "turn",
        type: "todo_list",
        status: "completed",
        ordinal: 1,
        updatedAt: now,
        steps: [{ text: "Aktuellen Kindauftrag lesen", status: "running" }],
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("returns the exact request and running plan step without waiting for a final result", () => {
  const projection = fixture();
  const result = voiceRunStatus(projection, projection.runs[0]!, now);
  assert.equal(result.request, "Prüfe Voice-Status");
  assert.equal(result.currentStep, "Aktuellen Kindauftrag lesen");
  assert.equal(result.visibility, "recent");
  assert.equal(result.ageMs, 0);
});

it("marks old evidence stale and does not turn completed work into a current step", () => {
  const projection = fixture();
  const later = DateTime.makeUnsafe("2026-10-23T15:02:00Z");
  const stale = voiceRunStatus(projection, projection.runs[0]!, later);
  assert.equal(stale.visibility, "stale");
  assert.isNull(stale.currentStep);
  assert.equal(stale.lastObservedStep?.text, "Aktuellen Kindauftrag lesen");
  assert.equal(stale.lastObservedStep?.ageMs, 120_000);
  const completed = { ...projection.runs[0]!, status: "completed" as const };
  const result = voiceRunStatus(projection, completed, later);
  assert.equal(result.visibility, "historical");
  assert.isNull(result.currentStep);
  assert.isNull(result.commentary);
});

it("reports unknown visibility and excludes reasoning, old attempts and raw tool data", () => {
  const projection = fixture();
  const template = projection.turnItems[0]!;
  const hidden = {
    ...projection,
    turnItems: [
      { ...template, type: "reasoning", text: "PRIVATE_REASONING" },
      { ...template, providerTurnId: "old-turn", type: "assistant_message", text: "OLD_RESULT" },
      { ...template, type: "dynamic_tool", input: "PRIVATE_INPUT", output: "PRIVATE_OUTPUT" },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const result = voiceRunStatus(hidden, hidden.runs[0]!, now);
  assert.equal(result.visibility, "unknown");
  assert.isNull(result.currentStep);
  assert.isNull(result.lastUpdate);
  assert.notInclude(JSON.stringify(result), "PRIVATE_");
  assert.notInclude(JSON.stringify(result), "OLD_RESULT");
});

it("does not resurrect an earlier running plan after its completed replacement", () => {
  const projection = fixture();
  const item = projection.turnItems[0]!;
  const replaced = {
    ...projection,
    turnItems: [
      ...projection.turnItems,
      { ...item, ordinal: 2, steps: [{ text: "Done", status: "completed" }] },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.isNull(voiceRunStatus(replaced, replaced.runs[0]!, now).currentStep);
});
