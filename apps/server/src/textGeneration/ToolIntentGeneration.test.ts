import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TextGeneration from "./TextGeneration.ts";
import * as Service from "./ToolIntentGeneration.ts";

const item = {
  id: TurnItemId.make("new-runtime-tool"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running" as const,
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  type: "dynamic_tool" as const,
  toolName: "mcp__runtime_capsule__compare",
  input: {
    shipmentIds: ["A", "B"],
    apiToken: "never-send-this",
    output: "never-copy-output",
    options: { password: "private", unit: "EUR" },
  },
};
const identity = {
  providerInstanceId: ProviderInstanceId.make("configured-account"),
  driverKind: ProviderDriverKind.make("codex"),
};

describe("tool intent generation", () => {
  it.effect(
    "bounds source and excludes credential/output fields without changing original data",
    () =>
      Effect.sync(() => {
        const source = Service.toolIntentInput(item);
        expect(source).toContain("shipmentIds");
        expect(source).not.toMatch(/never-send|never-copy|private|password|apiToken/);
        expect(item.input.apiToken).toBe("never-send-this");
        expect(
          Service.isToolIntentMissing({
            ...item,
            type: "command_execution",
            input: "cat docs/guide.md",
          }),
        ).toBe(false);
        expect(
          Service.toolIntentInput({ ...item, input: { code: "x".repeat(100_000) } }).length,
        ).toBeLessThanOrEqual(4096);
        for (const title of ["Run shell commands", "Running Python code", "Run JavaScript"]) {
          expect(Service.isToolIntentMissing({ ...item, title })).toBe(true);
          expect(
            Service.isToolIntentMissing({
              ...item,
              type: "command_execution",
              input: "opaque()",
              title,
            }),
          ).toBe(true);
        }
        expect(
          Service.isToolIntentMissing({ ...item, title: "Compare selected shipment quotes" }),
        ).toBe(false);
        expect(
          Service.isToolIntentMissing({
            ...item,
            toolName: "functions.exec",
            title: "Run shell commands",
            input: {
              code: "// Intent: Inspect recording permission preferences\nawait inspect();",
            },
          }),
        ).toBe(false);
      }),
  );

  it.effect(
    "does not await inference, shares identical in-flight requests, caches labels and uses a small explicit model",
    () =>
      Effect.gen(function* () {
        const requests = yield* Queue.make<{
          reply: Deferred.Deferred<{ title: string }, TextGenerationError>;
          input: TextGeneration.ThreadTitleGenerationInput;
        }>();
        const commits = yield* Queue.make<string>();
        const service = yield* Service.make.pipe(
          Effect.provide(
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: (input) =>
                Effect.gen(function* () {
                  const reply = yield* Deferred.make<{ title: string }, TextGenerationError>();
                  yield* Queue.offer(requests, { input, reply });
                  return yield* Deferred.await(reply);
                }),
            }),
          ),
        );
        const observe = (id: string, title: string | null = null) =>
          service.observe({
            ...identity,
            item: { ...item, id: TurnItemId.make(id), title },
            commitTitle: (label) => Queue.offer(commits, `${id}:${label}`).pipe(Effect.asVoid),
          });
        yield* observe("first");
        const request = yield* Queue.take(requests);
        expect(request.input.modelSelection).toEqual({
          instanceId: identity.providerInstanceId,
          model: "gpt-6-luna",
          options: [
            { id: "reasoningEffort", value: "low" },
            { id: "serviceTier", value: "priority" },
          ],
        });
        expect(request.input.linkedContext).toBe("");
        expect(request.input.cwd).not.toBe(process.cwd());
        expect(request.input.message).not.toContain("never-send-this");
        yield* observe("second");
        yield* observe("authored", "Compare selected shipment quotes");
        yield* Deferred.succeed(request.reply, { title: "Compare selected shipment quotes" });
        expect(yield* Queue.take(commits)).toBe("first:Compare selected shipment quotes");
        expect(yield* Queue.take(commits)).toBe("second:Compare selected shipment quotes");
        yield* observe("third");
        expect(yield* Queue.take(commits)).toBe("third:Compare selected shipment quotes");
        expect(yield* Queue.size(requests)).toBe(0);
        expect(service.retainedTitle({ ...item, id: TurnItemId.make("first") })).toBe(
          "Compare selected shipment quotes",
        );
        expect(
          service.retainedTitle({
            ...item,
            id: TurnItemId.make("first"),
            title: "Newer authored title",
          }),
        ).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "falls back after a failed inference without changing input or committing a title",
    () =>
      Effect.gen(function* () {
        const failed = yield* Deferred.make<void>();
        const committed: string[] = [];
        const service = yield* Service.make.pipe(
          Effect.provide(
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: () =>
                Deferred.succeed(failed, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new TextGenerationError({
                        operation: "generateThreadTitle",
                        detail: "Synthetic failure",
                      }),
                    ),
                  ),
                ),
            }),
          ),
        );
        yield* service.observe({
          ...identity,
          item,
          commitTitle: (title) =>
            Effect.sync(() => {
              committed.push(title);
            }),
        });
        yield* Deferred.await(failed);
        expect(service.retainedTitle(item)).toBeUndefined();
        expect(committed).toEqual([]);
        expect(item.input.apiToken).toBe("never-send-this");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
