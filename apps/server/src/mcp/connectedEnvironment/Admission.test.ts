import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Admission from "./Admission.ts";

it.effect("binds each admission to one app session and consumes it once", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.make.pipe(Effect.provide(NodeServices.layer));
    const id = yield* admission.create("first");
    expect(Result.isFailure(yield* Effect.result(admission.consume("other", id)))).toBe(true);
    expect(yield* admission.consume("first", id)).toBeGreaterThan(0);
    expect(Result.isFailure(yield* Effect.result(admission.consume("first", id)))).toBe(true);
  }),
);
