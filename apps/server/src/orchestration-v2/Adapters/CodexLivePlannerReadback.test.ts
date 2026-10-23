import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { appendCodexLivePlannerAnswer } from "./CodexLivePlannerReadback.ts";

it.effect(
  "returns a conversational planner answer once, excluding private and inactive output",
  () =>
    Effect.gen(function* () {
      const delivered = new Set<string>();
      const spoken: string[] = [];
      const append = (text: string) =>
        Effect.sync(() => {
          spoken.push(text);
        });
      const answer = {
        turnId: "question",
        item: {
          id: "answer",
          type: "agentMessage",
          phase: "final_answer",
          text: "Sales Guy and Web Dude.",
        },
      };
      assert.isFalse(yield* appendCodexLivePlannerAnswer(undefined, answer, append));
      for (const phase of ["analysis", "commentary", undefined]) {
        assert.isFalse(
          yield* appendCodexLivePlannerAnswer(
            delivered,
            {
              ...answer,
              item: { ...answer.item, phase, text: "Private or preliminary output" },
            },
            append,
          ),
        );
      }
      assert.isFalse(
        yield* appendCodexLivePlannerAnswer(
          delivered,
          {
            ...answer,
            item: { ...answer.item, type: "reasoning" },
          },
          append,
        ),
      );
      assert.isTrue(yield* appendCodexLivePlannerAnswer(delivered, answer, append));
      assert.isFalse(yield* appendCodexLivePlannerAnswer(delivered, answer, append));
      assert.deepEqual(spoken, ["Sales Guy and Web Dude."]);
    }),
);

it.effect("claims an in-flight answer once and permits retry after failed delivery", () =>
  Effect.gen(function* () {
    const delivered = new Set<string>();
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const answer = {
      turnId: "question",
      item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Answer" },
    };
    const pending = yield* appendCodexLivePlannerAnswer(delivered, answer, () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    assert.isFalse(yield* appendCodexLivePlannerAnswer(delivered, answer, () => Effect.void));
    yield* Deferred.succeed(finish, undefined);
    assert.isTrue(yield* Fiber.join(pending));
    const failedAnswer = { ...answer, item: { ...answer.item, id: "retry" } };
    yield* appendCodexLivePlannerAnswer(delivered, failedAnswer, () => Effect.fail("offline")).pipe(
      Effect.flip,
    );
    assert.isTrue(yield* appendCodexLivePlannerAnswer(delivered, failedAnswer, () => Effect.void));
  }),
);
