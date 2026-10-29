import {
  PreviewAutomationSnapshot,
  PreviewAutomationTabTargetInput,
  PreviewTabId,
  PreviewTextEdit,
  TrimmedNonEmptyString,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Step = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("type"),
    locator: TrimmedNonEmptyString,
    text: Schema.String,
    clear: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ operation: Schema.Literal("click"), locator: TrimmedNonEmptyString }),
  Schema.Struct({
    operation: Schema.Literal("press"),
    key: TrimmedNonEmptyString,
    modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
  }),
  Schema.Struct({ operation: Schema.Literal("waitFor"), text: TrimmedNonEmptyString }),
  Schema.Struct({
    operation: Schema.Literal("patchText"),
    locator: TrimmedNonEmptyString,
    edits: Schema.Array(PreviewTextEdit).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
]);
export type PreviewBatchStep = typeof Step.Type;
export const PreviewBatchInput = Schema.Struct({
  ...PreviewAutomationTabTargetInput.fields,
  tabId: PreviewTabId,
  expectedOrigin: TrimmedNonEmptyString.check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);
        return (
          (["http:", "https:"].includes(url.protocol) && url.origin === value) ||
          "Use an exact HTTP(S) origin without a path."
        );
      } catch {
        return "Use an exact HTTP(S) origin.";
      }
    }),
  ),
  steps: Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type PreviewBatchInput = typeof PreviewBatchInput.Type;
const StepResult = Schema.Struct({
  index: Schema.Number,
  operation: Schema.String,
  elapsedMs: Schema.Number,
  outcome: Schema.Literals(["returned", "failed", "blocked"]),
});
export const PreviewBatchResult = Schema.Struct({
  status: Schema.Literals(["actions_completed", "incomplete"]),
  taskSuccessVerified: Schema.Literal(false),
  steps: Schema.Array(StepResult),
  stoppedAt: Schema.NullOr(Schema.Number),
  deliveryUnknown: Schema.Boolean,
  readBeforeRetry: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  elapsedMs: Schema.Number,
  state: Schema.NullOr(PreviewAutomationSnapshot),
});
export type PreviewBatchResult = typeof PreviewBatchResult.Type;

/** Every step uses the ordinary caller-bound broker. No action is retried or substituted. */
export const executePreviewBatch = Effect.fn("PreviewBatch.execute")(function* <E, R>(
  input: PreviewBatchInput,
  executor: {
    readonly status: Effect.Effect<PreviewAutomationStatus, E, R>;
    readonly snapshot: Effect.Effect<PreviewAutomationSnapshot, E, R>;
    readonly action: (step: PreviewBatchStep) => Effect.Effect<unknown, E, R>;
  },
): Effect.fn.Return<PreviewBatchResult, never, R> {
  const start = performance.now();
  const steps: Array<typeof StepResult.Type> = [];
  let stoppedAt: number | null = null,
    reason: string | null = null,
    deliveryUnknown = false;
  for (const [index, step] of input.steps.entries()) {
    const stepStart = performance.now();
    const status = yield* executor.status.pipe(
      Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
    );
    const allowed =
      status?.tabId === input.tabId &&
      status.control?.owner === "agent" &&
      status.control.ownedByCaller === true &&
      !status.dialog &&
      !status.fileChooser &&
      URL.canParse(status.url ?? "") &&
      new URL(status.url!).origin === input.expectedOrigin;
    if (!allowed) {
      stoppedAt = index;
      reason = "Tab, origin, ownership, or dialog guard failed before this step.";
      steps.push({
        index,
        operation: step.operation,
        outcome: "blocked",
        elapsedMs: performance.now() - stepStart,
      });
      break;
    }
    const returned = yield* executor.action(step).pipe(
      Effect.match({
        onFailure: (cause) => ({
          ok: false,
          unsupported:
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "PreviewAutomationUnsupportedClientError",
        }),
        onSuccess: () => ({ ok: true, unsupported: false }),
      }),
    );
    steps.push({
      index,
      operation: step.operation,
      outcome: returned.ok ? "returned" : "failed",
      elapsedMs: performance.now() - stepStart,
    });
    if (!returned.ok) {
      stoppedAt = index;
      deliveryUnknown = !returned.unsupported && step.operation !== "waitFor";
      reason = returned.unsupported
        ? "This browser client does not support the requested operation. No substitute was attempted."
        : "Step failed. Inspect state before any retry; completed actions were not replayed.";
      break;
    }
  }
  const state = yield* executor.snapshot.pipe(
    Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
  );
  if (stoppedAt === null) {
    const observedOriginMatches =
      state !== null &&
      URL.canParse(state.url) &&
      new URL(state.url).origin === input.expectedOrigin;
    if (!observedOriginMatches) {
      stoppedAt = input.steps.length;
      reason = "Fresh final state on expectedOrigin is unavailable. Read before continuing.";
    }
  }
  // A returned browser action never establishes the requested business result.
  return {
    status: stoppedAt === null ? "actions_completed" : "incomplete",
    taskSuccessVerified: false,
    steps,
    stoppedAt,
    deliveryUnknown,
    readBeforeRetry: stoppedAt !== null,
    reason,
    elapsedMs: performance.now() - start,
    state,
  };
});
