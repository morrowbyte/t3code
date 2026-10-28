import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  TextGenerationError,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type OrchestrationV2TurnItem,
  type OrchestrationV2AppThread,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
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
        ).toBe(true);
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

it.effect(
  "uses the app text model, ignores a stale German reply and caches by selected language",
  () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        toolActivityLanguage: "de",
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("configured-text-provider"),
          model: "configured-small-model",
        },
      });
      const requests = yield* Queue.make<{
        input: TextGeneration.ThreadTitleGenerationInput;
        reply: Deferred.Deferred<{ title: string }>;
      }>();
      const commits = yield* Queue.make<string>();
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Ref.get(settings),
            }),
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: (input) =>
                Effect.gen(function* () {
                  const reply = yield* Deferred.make<{ title: string }>();
                  yield* Queue.offer(requests, { input, reply });
                  return yield* Deferred.await(reply);
                }),
            }),
          ),
        ),
      );
      const observe = (id: string) =>
        service.observe({
          ...identity,
          item: { ...item, id: TurnItemId.make(id) },
          commitTitle: (title) => Queue.offer(commits, title).pipe(Effect.asVoid),
        });
      yield* observe("language-first");
      const german = yield* Queue.take(requests);
      expect(german.input.modelSelection).toEqual(
        (yield* Ref.get(settings)).textGenerationModelSelection,
      );
      expect(german.input.instructions).toContain("German");
      yield* Ref.update(settings, (settings) => ({
        ...settings,
        toolActivityLanguage: "en" as const,
      }));
      yield* observe("language-first");
      yield* Deferred.succeed(german.reply, { title: "Veraltete deutsche Aktivität" });
      const english = yield* Queue.take(requests);
      expect(yield* Queue.size(commits)).toBe(0);
      expect(english.input.instructions).toContain("English");
      yield* Deferred.succeed(english.reply, { title: "Compare shipment quotes" });
      expect(yield* Queue.take(commits)).toBe("Compare shipment quotes");
      yield* observe("language-cached");
      expect(yield* Queue.take(commits)).toBe("Compare shipment quotes");
      expect(yield* Queue.size(requests)).toBe(0);
      const wrapped = {
        ...item,
        type: "command_execution" as const,
        input:
          '/run/current-system/sw/bin/bash -lc "# Intent: Isolierte Crew-Dev-Instanz starten\nnode dev"',
        title: "Start Isolated Crew Dev Instance",
      };
      expect(service.retainedTitle(wrapped)).toBe("Isolierte Crew-Dev-Instanz starten");
      expect(Service.isToolIntentMissing(wrapped)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "translates authored German and English labels as presentation without replacing the authored source",
  () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        toolActivityLanguage: "en",
      });
      const requests = yield* Queue.make<{
        input: TextGeneration.ThreadTitleGenerationInput;
        reply: Deferred.Deferred<{ title: string }>;
      }>();
      const committed = yield* Queue.make<{
        title: string;
        language: "auto" | "de" | "en";
        sourceTitle: string;
      }>();
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () =>
                Effect.succeed({
                  title: "Werkzeugbeschriftungen verbessern",
                  projectId: ProjectId.make("language-project"),
                } as OrchestrationV2AppThread),
            }),
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Ref.get(settings),
            }),
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: (input) =>
                Effect.gen(function* () {
                  const reply = yield* Deferred.make<{ title: string }>();
                  yield* Queue.offer(requests, { input, reply });
                  return yield* Deferred.await(reply);
                }),
            }),
          ),
        ),
      );
      const german = {
        ...item,
        type: "command_execution" as const,
        input: 'bash -lc "# Intent: Installierte Version prüfen\nprintf version"',
        title: "Check Installed Version",
      };
      const observe = (next: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>) =>
        service.observe({
          ...identity,
          item: next,
          commitTitle: () => Effect.die("Translation must not overwrite authored title"),
          commitPresentation: (presentation) =>
            presentation ? Queue.offer(committed, presentation).pipe(Effect.asVoid) : Effect.void,
        });
      yield* observe(german);
      const englishRequest = yield* Queue.take(requests);
      expect(englishRequest.input.instructions).toContain("English");
      expect(englishRequest.input.instructions).toContain("Translate ONLY");
      expect(englishRequest.input.message).toContain("Installierte Version prüfen");
      yield* Deferred.succeed(englishRequest.reply, { title: "Check installed version" });
      expect(yield* Queue.take(committed)).toEqual({
        title: "Check installed version",
        sourceTitle: "Installierte Version prüfen",
        language: "en",
      });
      expect(service.retainedPresentation(german)?.title).toBe("Check installed version");
      expect(german.input).toContain("Installierte Version prüfen");
      expect(german.title).toBe("Check Installed Version");
      yield* Ref.update(settings, (settings) => ({
        ...settings,
        toolActivityLanguage: "de" as const,
      }));
      const english = {
        ...german,
        input: "# Intent: Inspect recording permissions\npython3 inspect.py",
        title: null,
      };
      yield* observe(english);
      const germanRequest = yield* Queue.take(requests);
      expect(germanRequest.input.instructions).toContain("German");
      expect(service.retainedPresentation(english)).toBeUndefined();
      yield* Deferred.succeed(germanRequest.reply, { title: "Aufnahmeberechtigungen prüfen" });
      expect(yield* Queue.take(committed)).toEqual({
        title: "Aufnahmeberechtigungen prüfen",
        sourceTitle: "Inspect recording permissions",
        language: "de",
      });
      expect(
        service.retainedPresentation({
          ...english,
          input: "# Intent: Inspect another source\npython3 other.py",
        }),
      ).toBeUndefined();
      yield* Ref.update(settings, (settings) => ({
        ...settings,
        toolActivityLanguage: "auto" as const,
      }));
      yield* observe(english);
      const automatic = yield* Queue.take(requests);
      expect(automatic.input.instructions).toContain("Do not default to English");
      expect(automatic.input.message).toContain("Werkzeugbeschriftungen verbessern");
      yield* Deferred.succeed(automatic.reply, { title: "Aufnahmeberechtigungen prüfen" });
      expect(yield* Queue.take(committed)).toEqual({
        title: "Aufnahmeberechtigungen prüfen",
        sourceTitle: "Inspect recording permissions",
        language: "auto",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
