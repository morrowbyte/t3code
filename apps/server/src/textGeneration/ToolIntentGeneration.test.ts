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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { vi } from "vite-plus/test";
import { TestClock } from "effect/testing";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as Service from "./ToolIntentGeneration.ts";
import { toolActivitySourceTitle } from "@t3tools/shared/toolActivity";

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
  it.effect("keeps capacity when interrupted immediately after acquiring a slot", () =>
    Effect.gen(function* () {
      const prototype = Object.getPrototypeOf(Semaphore.makeUnsafe(1)) as Semaphore.Semaphore;
      const take = prototype.take;
      const takeIfAvailable = prototype.takeIfAvailable;
      let armed = false;
      let acquired: Semaphore.Semaphore | undefined;
      const interruptAfterAcquire = <A>(
        semaphore: Semaphore.Semaphore,
        effect: Effect.Effect<A>,
        succeeded: (value: A) => boolean,
      ) =>
        Effect.flatMap(effect, (value) =>
          Effect.withFiber((fiber) => {
            if (armed && succeeded(value)) {
              armed = false;
              acquired = semaphore;
              fiber.interruptUnsafe();
            }
            return Effect.succeed(value);
          }),
        );
      using _take = vi.spyOn(prototype, "take").mockImplementation(function (
        this: Semaphore.Semaphore,
        permits,
      ) {
        return interruptAfterAcquire(this, take.call(this, permits), () => true);
      });
      using _takeIfAvailable = vi.spyOn(prototype, "takeIfAvailable").mockImplementation(function (
        this: Semaphore.Semaphore,
        permits,
      ) {
        return interruptAfterAcquire(this, takeIfAvailable.call(this, permits), Boolean);
      });
      let commits = 0;
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mock(TextGeneration.TextGeneration)({
            generateThreadTitle: () => Effect.succeed({ title: "Inspect pending request" }),
          }),
        ),
      );
      armed = true;
      const observing = yield* service
        .observe({
          ...identity,
          item,
          commitTitle: () =>
            Effect.sync(() => {
              commits++;
            }),
        })
        .pipe(Effect.forkChild);
      yield* Fiber.await(observing);
      yield* TestClock.adjust(0);
      expect(acquired).toBeDefined();
      const allAvailable = yield* acquired!.takeIfAvailable(512);
      expect(allAvailable).toBe(true);
      if (allAvailable) yield* acquired!.release(512);
      expect(commits).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves every completion with backpressure after 512 pending items", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      let calls = 0;
      let accepted = false;
      const committed: string[] = [];
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mock(TextGeneration.TextGeneration)({
            generateThreadTitle: () =>
              Effect.gen(function* () {
                if (++calls === 1) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                return { title: `Inspect request ${calls}` };
              }),
          }),
        ),
      );
      const observe = (index: number) =>
        service.observe({
          ...identity,
          item: {
            ...item,
            id: TurnItemId.make(`capacity-${index}`),
            input: { index },
            status: "completed",
          },
          commitTitle: (title) =>
            Effect.gen(function* () {
              committed.push(title);
              if (committed.length === 513) yield* Deferred.succeed(finished, undefined);
            }),
        });
      for (let index = 0; index < 512; index++) {
        yield* observe(index);
        if (index === 0) yield* Deferred.await(started);
      }
      const overflow = yield* observe(512).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            accepted = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust(0);
      expect(accepted).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(overflow);
      yield* Deferred.await(finished);
      expect(calls).toBe(513);
      expect(committed).toHaveLength(513);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces a waiting admission before capacity is available", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const messages: string[] = [];
      const committed: number[] = [];
      let oldAdmitted = false;
      let staleCommits = 0;
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mock(TextGeneration.TextGeneration)({
            generateThreadTitle: (request) =>
              Effect.gen(function* () {
                messages.push(request.message);
                if (messages.length === 1) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                return { title: `Inspect request ${messages.length}` };
              }),
          }),
        ),
      );
      const observe = (index: number, revision = "initial") =>
        service.observe({
          ...identity,
          item: { ...item, id: TurnItemId.make(`replace-${index}`), input: { index, revision } },
          commitTitle: () =>
            Effect.gen(function* () {
              if (revision === "old-waiter") staleCommits++;
              committed.push(index);
              if (committed.length === 513) yield* Deferred.succeed(finished, undefined);
            }),
        });
      for (let index = 0; index < 512; index++) {
        yield* observe(index);
        if (index === 0) yield* Deferred.await(started);
      }
      const old = yield* observe(512, "old-waiter").pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            oldAdmitted = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust(0);
      expect(oldAdmitted).toBe(false);
      const current = yield* observe(512, "new-waiter").pipe(Effect.forkChild);
      yield* TestClock.adjust(0);
      expect(oldAdmitted).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(old);
      yield* Fiber.join(current);
      yield* Deferred.await(finished);
      expect(messages).toHaveLength(513);
      expect(messages.some((message) => message.includes("old-waiter"))).toBe(false);
      expect(messages.some((message) => message.includes("new-waiter"))).toBe(true);
      expect(staleCommits).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shares a Boat translation while binding each subscriber's own source title", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<{ title: string }>();
      let calls = 0;
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                toolActivityLanguage: "de",
              }),
            }),
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: () =>
                Effect.gen(function* () {
                  calls++;
                  yield* Deferred.succeed(started, undefined);
                  return yield* Deferred.await(reply);
                }),
            }),
          ),
        ),
      );
      const first = {
        ...item,
        id: TurnItemId.make("boat-first"),
        toolName: "boat_environment",
        title: "Boot-Umgebung",
        input: { request: { command: "# Intent: Cache prüfen\nnode check.js" } },
      };
      const second = { ...first, id: TurnItemId.make("boat-second"), title: "Boat environment" };
      const observe = (next: typeof first) =>
        service.observe({
          ...identity,
          item: next,
          commitTitle: () => Effect.die("Preserve source"),
        });
      yield* observe(first);
      yield* Deferred.await(started);
      yield* observe(second);
      yield* Deferred.succeed(reply, { title: "Cache prüfen" });
      yield* TestClock.adjust(0);
      expect(calls).toBe(1);
      expect(service.retainedPresentation(first)?.sourceTitle).toBe(first.title);
      expect(service.retainedPresentation(second)?.sourceTitle).toBe(second.title);
      expect(service.retainedPresentation(second)?.title).toBe("Cache prüfen");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "drains a completed burst beyond the old pending limit without another observation",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const requests: string[] = [];
        const committed: string[] = [];
        const service = yield* Service.make.pipe(
          Effect.provide(
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: (input) =>
                Effect.gen(function* () {
                  requests.push(input.message);
                  if (requests.length === 1) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                  }
                  return { title: `Inspect request ${requests.length}` };
                }),
            }),
          ),
        );
        for (let index = 0; index < 33; index += 1) {
          yield* service.observe({
            ...identity,
            item: {
              ...item,
              id: TurnItemId.make(`burst-${index}`),
              status: "completed",
              input: { index },
            },
            commitTitle: (title) =>
              Effect.sync(() => {
                committed.push(title);
              }),
          });
          if (index === 0) yield* Deferred.await(started);
        }
        yield* Deferred.succeed(release, undefined);
        yield* TestClock.adjust(0);
        expect(requests).toHaveLength(33);
        expect(committed).toHaveLength(33);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("recovers from one failed generation without permanently caching failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const committed: string[] = [];
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mock(TextGeneration.TextGeneration)({
            generateThreadTitle: () =>
              Effect.suspend(() => {
                attempts += 1;
                return attempts === 1
                  ? Effect.fail(
                      new TextGenerationError({
                        operation: "generateThreadTitle",
                        detail: "Temporary overload",
                      }),
                    )
                  : Effect.succeed({ title: "Compare shipment quotes" });
              }),
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
      yield* TestClock.adjust(0);
      expect(attempts).toBe(2);
      expect(committed).toEqual(["Compare shipment quotes"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shares one generation across more than 32 completed subscribers", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let requests = 0;
      const committed: string[] = [];
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mock(TextGeneration.TextGeneration)({
            generateThreadTitle: () =>
              Effect.gen(function* () {
                requests += 1;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return { title: "Compare shipment quotes" };
              }),
          }),
        ),
      );
      for (let index = 0; index < 33; index += 1) {
        yield* service.observe({
          ...identity,
          item: { ...item, id: TurnItemId.make(`subscriber-${index}`), status: "completed" },
          commitTitle: (title) =>
            Effect.sync(() => {
              committed.push(title);
            }),
        });
        if (index === 0) yield* Deferred.await(started);
      }
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust(0);
      expect(requests).toBe(1);
      expect(committed).toHaveLength(33);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("discards an older observation whose context finishes after the newer title", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<ServerSettings>();
      let reads = 0;
      const requested: string[] = [];
      const committed: string[] = [];
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Effect.suspend(() => {
                reads += 1;
                return reads === 1
                  ? Deferred.succeed(reading, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.succeed(DEFAULT_SERVER_SETTINGS);
              }),
            }),
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: (input) =>
                Effect.sync(() => {
                  const title = input.message.includes("older")
                    ? "Older activity"
                    : "Newer activity";
                  requested.push(title);
                  return { title };
                }),
            }),
          ),
        ),
      );
      const observe = (revision: string) =>
        service.observe({
          ...identity,
          item: { ...item, input: { revision } },
          commitTitle: (title) =>
            Effect.sync(() => {
              committed.push(title);
            }),
        });
      const older = yield* observe("older").pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      yield* observe("newer");
      yield* TestClock.adjust(0);
      yield* Deferred.succeed(release, DEFAULT_SERVER_SETTINGS);
      yield* Fiber.join(older);
      yield* TestClock.adjust(0);
      expect(requested).toEqual(["Newer activity"]);
      expect(committed).toEqual(["Newer activity"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the command intent before a generic Boat label without changing its source", () =>
    Effect.gen(function* () {
      const requests: TextGeneration.ThreadTitleGenerationInput[] = [];
      const service = yield* Service.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                toolActivityLanguage: "de",
              }),
            }),
            Layer.mock(TextGeneration.TextGeneration)({
              generateThreadTitle: (input) =>
                Effect.sync(() => {
                  requests.push(input);
                  return { title: "Cache-Schlüssel prüfen" };
                }),
            }),
          ),
        ),
      );
      const next = {
        ...item,
        toolName: "mcp__t3_code__boat_environment",
        title: "Boot-Umgebung",
        input: {
          request: { action: "exec", command: "# Intent: Cache-Schlüssel prüfen\nnode check.js" },
        },
      };
      yield* service.observe({
        ...identity,
        item: next,
        commitTitle: () => Effect.die("Preserve source"),
      });
      yield* TestClock.adjust(0);
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0]!.message).authoredActivityLabel).toBe("Cache-Schlüssel prüfen");
      expect(requests[0]!.instructions).toContain("Boat is not Boot");
      expect(service.retainedPresentation(next)?.sourceTitle).toBe("Boot-Umgebung");
      expect(service.retainedPresentation(next)?.title).toBe("Cache-Schlüssel prüfen");
      expect(next.title).toBe("Boot-Umgebung");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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
      expect(service.retainedTitle(wrapped)).toBeUndefined();
      expect(toolActivitySourceTitle(wrapped)).toBe("Isolierte Crew-Dev-Instanz starten");
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
