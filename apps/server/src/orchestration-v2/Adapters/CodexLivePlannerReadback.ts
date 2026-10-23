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
  yield* append(item.text).pipe(Effect.onError(() => Effect.sync(() => delivered.delete(key))));
  if (delivered.size > 128) {
    const oldest = delivered.values().next().value;
    if (oldest !== undefined) delivered.delete(oldest);
  }
  return true;
});
