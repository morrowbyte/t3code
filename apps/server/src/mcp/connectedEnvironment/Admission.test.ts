import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Admission from "./Admission.ts";

it.effect("binds each admission to one app session and consumes it once", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.make.pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const id = yield* admission.create("first");
    expect(Result.isFailure(yield* Effect.result(admission.consume("other", id)))).toBe(true);
    expect(yield* admission.consume("first", id)).toBeGreaterThan(0);
    expect(Result.isFailure(yield* Effect.result(admission.consume("first", id)))).toBe(true);
  }),
);
