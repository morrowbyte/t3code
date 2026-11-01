import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  ServerSettingsError,
  TextGenerationError,
  type ServerSettings,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";
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

const setup = (
  options: {
    automaticReplies?: boolean;
    unavailableContext?: boolean;
    slowContext?: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
  } = {},
) =>
  Effect.gen(function* () {
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
    const calls: Array<TextGeneration.ThreadTitleGenerationInput> = [];
    let active = 0;
    let maximumActive = 0;
    let contextReads = 0;
    const service = yield* Service.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: Effect.suspend(() => {
              contextReads += 1;
              if (options.slowContext && contextReads === 1)
                return Deferred.succeed(options.slowContext.started, undefined).pipe(
                  Effect.andThen(Deferred.await(options.slowContext.release)),
                  Effect.andThen(Ref.get(settings)),
                );
              return options.unavailableContext && contextReads === 1
                ? Effect.fail(
                    new ServerSettingsError({
                      operation: "read-file",
                      settingsPath: "/fixture/settings.json",
                    }),
                  )
                : Ref.get(settings);
            }),
          }),
          Layer.mock(TextGeneration.TextGeneration)({
            generateThreadTitle: (input) =>
              Effect.gen(function* () {
                calls.push(input);
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                const reply = yield* Deferred.make<{ title: string }, TextGenerationError>();
                yield* Queue.offer(requests, { input, reply });
                if (options.automaticReplies && calls.length > 1)
                  return { title: `Zusammenfassung ${calls.length}` };
                return yield* Deferred.await(reply);
              }).pipe(Effect.ensuring(Effect.sync(() => active--))),
          }),
        ),
      ),
    );
    return {
      settings,
      requests,
      commits,
      calls,
      maximumActive: () => maximumActive,
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
    "does not lose capacity when admission is interrupted just after acquiring a permit",
    () =>
      Effect.gen(function* () {
        const prototype: Semaphore.Semaphore = Object.getPrototypeOf(Semaphore.makeUnsafe(1));
        const take = prototype.take;
        const takeIfAvailable = prototype.takeIfAvailable;
        let armed = false;
        const acquired: { semaphore?: Semaphore.Semaphore } = {};
        using _take = vi.spyOn(prototype, "take").mockImplementation(function (
          this: Semaphore.Semaphore,
          permits: number,
        ) {
          return take.call(this, permits).pipe(
            Effect.flatMap((value) =>
              Effect.withFiber((fiber) => {
                if (armed) {
                  armed = false;
                  acquired.semaphore = this;
                  fiber.interruptUnsafe();
                }
                return Effect.succeed(value);
              }),
            ),
          );
        });
        using _takeIfAvailable = vi
          .spyOn(prototype, "takeIfAvailable")
          .mockImplementation(function (this: Semaphore.Semaphore, permits: number) {
            return takeIfAvailable.call(this, permits).pipe(
              Effect.flatMap((value) =>
                Effect.withFiber((fiber) => {
                  if (armed && value) {
                    armed = false;
                    acquired.semaphore = this;
                    fiber.interruptUnsafe();
                  }
                  return Effect.succeed(value);
                }),
              ),
            );
          });
        const h = yield* setup({ automaticReplies: true });
        yield* h.observe();
        const first = yield* Queue.take(h.requests);
        yield* Deferred.succeed(first.reply, { title: "Initiale Zusammenfassung" });
        yield* Queue.take(h.commits);
        yield* TestClock.adjust(0);

        armed = true;
        const admission = yield* h
          .observe({ ...item, id: TurnItemId.make("interrupted-admission") })
          .pipe(Effect.forkChild);
        expect((yield* Fiber.await(admission))._tag).toBe("Failure");
        yield* TestClock.adjust(0);
        expect(acquired.semaphore).toBeDefined();
        const available = yield* acquired.semaphore!.takeIfAvailable(512);
        if (available) yield* acquired.semaphore!.release(512);
        expect(available).toBe(true);
        expect(h.calls).toHaveLength(2);
        expect(yield* Queue.size(h.commits)).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("continues all 17 distinct completions without observing them again", () =>
    Effect.gen(function* () {
      const h = yield* setup({ automaticReplies: true });
      const completed = Array.from({ length: 17 }, (_, index) => ({
        ...item,
        id: TurnItemId.make(`completed-${index}`),
        text: `Public provider summary ${index}: inspect the Boat environment.`,
      }));
      yield* h.observe(completed[0]!);
      const first = yield* Queue.take(h.requests);
      for (const next of completed.slice(1)) yield* h.observe(next);
      yield* Deferred.succeed(first.reply, { title: "Boat-Umgebung prüfen" });
      yield* TestClock.adjust(0);
      expect(h.calls).toHaveLength(17);
      expect(yield* Queue.size(h.commits)).toBe(17);
      expect(h.maximumActive()).toBe(1);
      for (const next of completed) expect(h.service.retainedTitle(next)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "backpressures the 513th distinct item until processing finishes and coalesces queued updates",
    () =>
      Effect.gen(function* () {
        const h = yield* setup({ automaticReplies: true });
        const completed = Array.from({ length: 513 }, (_, index) => ({
          ...item,
          id: TurnItemId.make(`bounded-${index}`),
          text: `Public provider summary ${index}: inspect the Boat environment.`,
        }));
        const commitStarted = yield* Deferred.make<void>();
        const releaseCommit = yield* Deferred.make<void>();
        const allCommitted = yield* Deferred.make<void>();
        let commitCount = 0;
        const commitTitle = (title: string) =>
          Queue.offer(h.commits, title).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                commitCount += 1;
                return commitCount === completed.length
                  ? Deferred.succeed(allCommitted, undefined).pipe(Effect.asVoid)
                  : Effect.void;
              }),
            ),
          );
        const observe = (next: typeof item) =>
          h.service.observe({ ...identity, item: next, commitTitle });
        yield* h.service.observe({
          ...identity,
          item: completed[0]!,
          commitTitle: (title) =>
            Deferred.succeed(commitStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCommit)),
              Effect.andThen(commitTitle(title)),
              Effect.asVoid,
            ),
        });
        const first = yield* Queue.take(h.requests);
        for (const next of completed.slice(1, 512)) yield* observe(next);
        const admitted = yield* Deferred.make<void>();
        const overflow = yield* observe(completed[512]!).pipe(
          Effect.andThen(Deferred.succeed(admitted, undefined)),
          Effect.forkChild,
        );
        const updated = { ...completed[511]!, text: "Updated public summary about Boat." };
        const coalesced = yield* Deferred.make<void>();
        const updating = yield* observe(updated).pipe(
          Effect.andThen(Deferred.succeed(coalesced, undefined)),
          Effect.forkChild,
        );
        yield* TestClock.adjust(0);
        expect(yield* Deferred.isDone(admitted)).toBe(false);
        expect(yield* Deferred.isDone(coalesced)).toBe(true);
        expect(h.calls).toHaveLength(1);

        yield* Deferred.succeed(first.reply, { title: "Boat-Umgebung prüfen" });
        yield* Deferred.await(commitStarted);
        yield* TestClock.adjust(0);
        expect(yield* Deferred.isDone(admitted)).toBe(false);
        expect(h.calls).toHaveLength(1);

        yield* Deferred.succeed(releaseCommit, undefined);
        yield* Fiber.join(overflow);
        yield* Fiber.join(updating);
        yield* Deferred.await(allCommitted);
        expect(h.calls).toHaveLength(513);
        expect(yield* Queue.size(h.commits)).toBe(513);
        expect(h.maximumActive()).toBe(1);
        const summaries = h.calls.map((call) => JSON.parse(call.message).publicProviderSummary);
        expect(summaries).not.toContain(completed[511]!.text);
        expect(summaries).toContain(updated.text);
        expect(summaries).toContain(completed[512]!.text);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["streaming", "empty", "updated", "interrupted"] as const)(
    "retires a capacity-waiting admission after %s and preserves a newer completion",
    (change) =>
      Effect.gen(function* () {
        const h = yield* setup({ automaticReplies: true });
        const replacing = change === "updated" || change === "interrupted";
        const expectedCommits = replacing ? 513 : 512;
        const allCommitted = yield* Deferred.make<void>();
        let commitCount = 0;
        const observe = (next: typeof item) =>
          h.service.observe({
            ...identity,
            item: next,
            commitTitle: (title) =>
              Queue.offer(h.commits, title).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    commitCount += 1;
                    return commitCount === expectedCommits
                      ? Deferred.succeed(allCommitted, undefined).pipe(Effect.asVoid)
                      : Effect.void;
                  }),
                ),
              ),
          });
        yield* observe(item);
        const first = yield* Queue.take(h.requests);
        for (let index = 1; index < 512; index++) {
          yield* observe({ ...item, id: TurnItemId.make(`occupied-${index}`) });
        }
        const waiting = {
          ...item,
          id: TurnItemId.make("waiting-summary"),
          text: "Old public summary waiting for capacity.",
        };
        const retired = yield* Deferred.make<void>();
        const admission = yield* observe(waiting).pipe(
          Effect.ensuring(Deferred.succeed(retired, undefined)),
          Effect.forkChild,
        );
        yield* TestClock.adjust(0);
        expect(yield* Deferred.isDone(retired)).toBe(false);

        const current = { ...waiting, text: "Current public summary about Boat." };
        const replacementAdmitted = yield* Deferred.make<void>();
        if (change === "interrupted") yield* Fiber.interrupt(admission);
        if (replacing) {
          yield* observe(current).pipe(
            Effect.andThen(Deferred.succeed(replacementAdmitted, undefined)),
            Effect.forkChild,
          );
        } else {
          yield* observe(
            change === "streaming"
              ? { ...waiting, status: "running", streaming: true }
              : { ...waiting, text: "" },
          );
        }
        yield* TestClock.adjust(0);
        expect(yield* Deferred.isDone(retired)).toBe(true);
        expect(yield* Deferred.isDone(replacementAdmitted)).toBe(false);
        expect(h.calls).toHaveLength(1);
        const exit = yield* Fiber.await(admission);
        expect(exit._tag).toBe(change === "interrupted" ? "Failure" : "Success");

        yield* Deferred.succeed(first.reply, { title: "Erste Zusammenfassung" });
        yield* Deferred.await(allCommitted);
        expect(h.calls).toHaveLength(expectedCommits);
        expect(yield* Queue.size(h.commits)).toBe(expectedCommits);
        const summaries = h.calls.map((call) => JSON.parse(call.message).publicProviderSummary);
        expect(summaries).not.toContain(waiting.text);
        if (replacing) {
          expect(yield* Deferred.isDone(replacementAdmitted)).toBe(true);
          expect(summaries.filter((summary) => summary === current.text)).toHaveLength(1);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("coalesces a superseded queued completion before calling the model", () =>
    Effect.gen(function* () {
      const h = yield* setup({ automaticReplies: true });
      yield* h.observe();
      const first = yield* Queue.take(h.requests);
      const queued = {
        ...item,
        id: TurnItemId.make("queued-summary"),
        text: "Old public provider summary about the parser.",
      };
      yield* h.observe(queued);
      yield* h.observe({ ...queued, text: "Current public provider summary about Boat." });
      yield* Deferred.succeed(first.reply, { title: "Parser prüfen" });
      yield* TestClock.adjust(0);
      expect(h.calls).toHaveLength(2);
      expect(JSON.parse(h.calls[1]!.message)).toMatchObject({
        publicProviderSummary: "Current public provider summary about Boat.",
      });
      expect(yield* Queue.size(h.commits)).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not let an older context read replace a newer observed completion", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* setup({ automaticReplies: true, slowContext: { started, release } });
      const old = { ...item, text: "Old public provider summary." };
      const current = { ...item, text: "Current public provider summary about Boat." };
      const observingOld = yield* h.observe(old).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* h.observe(current);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(observingOld);
      const request = yield* Queue.take(h.requests);
      expect(JSON.parse(request.input.message)).toMatchObject({
        publicProviderSummary: current.text,
      });
      yield* Deferred.succeed(request.reply, { title: "Aktuelle Boat-Zusammenfassung" });
      yield* TestClock.adjust(0);
      expect(h.calls).toHaveLength(1);
      expect(yield* Queue.take(h.commits)).toBe("Aktuelle Boat-Zusammenfassung");
      expect(h.service.retainedTitle(old)).toBeUndefined();
      expect(h.service.retainedTitle(current)).toBe("Aktuelle Boat-Zusammenfassung");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves queued language and the selected text model at dispatch", () =>
    Effect.gen(function* () {
      const h = yield* setup({ automaticReplies: true });
      yield* h.observe();
      const first = yield* Queue.take(h.requests);
      const queued = {
        ...item,
        id: TurnItemId.make("queued-context"),
        text: "Inspect the Boat workspace before starting the test.",
      };
      yield* h.observe(queued);
      const selection = {
        instanceId: ProviderInstanceId.make("updated-text-provider"),
        model: "updated-text-model",
        options: [{ id: "serviceTier", value: "priority" }],
      };
      yield* Ref.update(h.settings, (settings) => ({
        ...settings,
        toolActivityLanguage: "en" as const,
        textGenerationModelSelection: selection,
      }));
      yield* Deferred.succeed(first.reply, { title: "Veraltete deutsche Zusammenfassung" });
      yield* TestClock.adjust(0);
      const request = h.calls.find(
        (call) => JSON.parse(call.message).publicProviderSummary === queued.text,
      );
      expect(request).toBeDefined();
      expect(request!.modelSelection).toEqual(selection);
      expect(request!.instructions).toContain("English");
      expect(h.service.retainedTitle(queued)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["error", "timeout"] as const)(
    "retries a transient %s once without another completion and ignores the old reply",
    (failure) =>
      Effect.gen(function* () {
        const h = yield* setup({ automaticReplies: true });
        yield* h.observe();
        const first = yield* Queue.take(h.requests);
        if (failure === "timeout") yield* TestClock.adjust("20 seconds");
        else
          yield* Deferred.fail(
            first.reply,
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Transient fixture",
            }),
          );
        yield* TestClock.adjust(0);
        expect(h.calls).toHaveLength(2);
        expect(yield* Queue.size(h.commits)).toBe(1);
        expect(h.service.retainedTitle(item)).toBe("Zusammenfassung 2");
        yield* Deferred.succeed(first.reply, { title: "Veraltete Zusammenfassung" });
        yield* TestClock.adjust(0);
        expect(h.calls).toHaveLength(2);
        expect(h.service.retainedTitle(item)).toBe("Zusammenfassung 2");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds automatic failures and permits a later completion to try again", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const error = new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Repeated transient fixture",
      });
      yield* h.observe();
      const first = yield* Queue.take(h.requests);
      yield* Deferred.fail(first.reply, error);
      yield* TestClock.adjust(0);
      expect(h.calls).toHaveLength(2);
      const second = yield* Queue.take(h.requests);
      yield* Deferred.fail(second.reply, error);
      yield* TestClock.adjust(0);
      expect(h.calls).toHaveLength(2);
      expect(yield* Queue.size(h.commits)).toBe(0);
      yield* h.observe();
      yield* TestClock.adjust(0);
      expect(h.calls).toHaveLength(3);
      const third = yield* Queue.take(h.requests);
      yield* Deferred.succeed(third.reply, { title: "Erneuter Versuch erfolgreich" });
      expect(yield* Queue.take(h.commits)).toBe("Erneuter Versuch erfolgreich");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retries unavailable context without choosing a fallback text model", () =>
    Effect.gen(function* () {
      const h = yield* setup({ unavailableContext: true });
      yield* h.observe();
      yield* TestClock.adjust(0);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.modelSelection).toEqual(
        (yield* Ref.get(h.settings)).textGenerationModelSelection,
      );
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { title: "Kontextgestützte Zusammenfassung" });
      expect(yield* Queue.take(h.commits)).toBe("Kontextgestützte Zusammenfassung");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not commit a late reply over a newer provider title", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.observe();
      const first = yield* Queue.take(h.requests);
      const changed = { ...item, title: "Neue Boat-Prüfung" };
      yield* h.observe(changed);
      yield* Deferred.succeed(first.reply, { title: "Veralteter Titel" });
      yield* TestClock.adjust(0);
      expect(yield* Queue.size(h.commits)).toBe(0);
      expect(h.service.retainedTitle(changed)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "ignores streaming deltas, deduplicates completion and uses the configured text model and language",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
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
        const h = yield* setup();
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
