import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ServerSettings,
  type TextGenerationError,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TextGeneration from "./TextGeneration.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as Service from "./ReasoningSummaryGeneration.ts";

const item: Extract<OrchestrationV2TurnItem, { type: "reasoning" }> = {
  id: TurnItemId.make("public-summary"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  type: "reasoning" as const,
  text: "Compare the two supported parsers before choosing a fix.",
  streaming: false,
};
const identity = {
  providerInstanceId: ProviderInstanceId.make("main-agent"),
  driverKind: ProviderDriverKind.make("codex"),
};

const setup = Effect.gen(function* () {
  const settings = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    toolActivityLanguage: "de",
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make("small-text-provider"),
      model: "configured-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
  });
  const requests = yield* Queue.make<{
    input: TextGeneration.ThreadTitleGenerationInput;
    reply: Deferred.Deferred<{ title: string }, TextGenerationError>;
  }>();
  const commits = yield* Queue.make<string>();
  const service = yield* Service.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({ getSettings: Ref.get(settings) }),
        Layer.mock(TextGeneration.TextGeneration)({
          generateThreadTitle: (input) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<{ title: string }, TextGenerationError>();
              yield* Queue.offer(requests, { input, reply });
              return yield* Deferred.await(reply);
            }),
        }),
      ),
    ),
  );
  return {
    settings,
    requests,
    commits,
    service,
    observe: (next = item) =>
      service.observe({
        ...identity,
        item: next,
        commitTitle: (title) => Queue.offer(commits, title).pipe(Effect.asVoid),
      }),
  };
});

describe("completed public reasoning summaries", () => {
  it.effect(
    "ignores streaming deltas, deduplicates completion and uses the configured text model and language",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* h.observe({ ...item, streaming: true, status: "running", text: "Compare" });
        yield* h.observe({ ...item, streaming: true, status: "running" });
        expect(yield* Queue.size(h.requests)).toBe(0);
        yield* h.observe();
        const request = yield* Queue.take(h.requests);
        expect(request.input.modelSelection).toEqual(
          (yield* Ref.get(h.settings)).textGenerationModelSelection,
        );
        expect(request.input.instructions).toContain("German");
        expect(request.input.instructions).toContain("already public");
        expect(request.input.instructions).toContain("private hidden chain of thought");
        yield* h.observe();
        yield* Deferred.succeed(request.reply, {
          title: "Die zwei unterstützten Parser werden verglichen.",
        });
        expect(yield* Queue.take(h.commits)).toBe(
          "Die zwei unterstützten Parser werden verglichen.",
        );
        yield* h.observe();
        expect(yield* Queue.size(h.requests)).toBe(0);
        expect(h.service.retainedTitle(item)).toBe(
          "Die zwei unterstützten Parser werden verglichen.",
        );
        expect(item.text).toBe("Compare the two supported parsers before choosing a fix.");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "discards stale source and language replies and separates cached completion language",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* h.observe();
        const old = yield* Queue.take(h.requests);
        const changed = {
          ...item,
          text: "Check the parser wrapper rather than changing the executor.",
        };
        yield* h.observe(changed);
        yield* Deferred.succeed(old.reply, { title: "Veraltete Parserentscheidung" });
        const current = yield* Queue.take(h.requests);
        expect(yield* Queue.size(h.commits)).toBe(0);
        yield* Ref.update(h.settings, (settings) => ({
          ...settings,
          toolActivityLanguage: "en" as const,
        }));
        yield* h.observe(changed);
        yield* Deferred.succeed(current.reply, { title: "Veraltete deutsche Kurzfassung" });
        const english = yield* Queue.take(h.requests);
        expect(yield* Queue.size(h.commits)).toBe(0);
        expect(english.input.instructions).toContain("English");
        yield* Deferred.succeed(english.reply, {
          title: "The shell wrapper is checked before changing execution.",
        });
        expect(yield* Queue.take(h.commits)).toBe(
          "The shell wrapper is checked before changing execution.",
        );
        expect(h.service.retainedTitle(item)).toBeUndefined();
        expect(h.service.retainedTitle(changed)).toBe(
          "The shell wrapper is checked before changing execution.",
        );
        yield* h.observe({ ...changed, streaming: true, status: "running" });
        expect(h.service.retainedTitle(changed)).toBeUndefined();
        expect(yield* Queue.size(h.requests)).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
