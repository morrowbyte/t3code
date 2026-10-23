import * as Effect from "effect/Effect";

/** Client-managed handoffs suppress native answer forwarding, including ordinary conversation. */
export const appendCodexLivePlannerAnswer = Effect.fn("CodexLivePlannerReadback.append")(function* <
  E,
>(
  delivered: Set<string> | undefined,
  input: {
    readonly turnId: string;
    readonly item: {
      readonly id: string;
      readonly type: string;
      readonly phase?: string | null | undefined;
      readonly text?: string;
    };
  },
  append: (text: string) => Effect.Effect<void, E>,
) {
  const { item } = input;
  if (
    delivered === undefined ||
    item.type !== "agentMessage" ||
    item.phase !== "final_answer" ||
    !item.text?.trim()
  )
    return false;
  const key = `${input.turnId}:${item.id}`;
  if (delivered.has(key)) return false;
  delivered.add(key);
  yield* Effect.annotateCurrentSpan({
    "voice.planner.turn_id": input.turnId,
    "voice.planner.answer_item_id": item.id,
  });
  // The native append API has no idempotency key. A failed acknowledgement
  // can follow acceptance, so retain this session's claim even on failure.
  yield* append(item.text).pipe(
    Effect.onError(() => Effect.annotateCurrentSpan("voice.planner.answer_delivery", "unknown")),
  );
  yield* Effect.annotateCurrentSpan("voice.planner.answer_appended", true);
  return true;
});
