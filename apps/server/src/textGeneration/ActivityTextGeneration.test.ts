import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ServerSettingsError,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Service from "./ActivityTextGeneration.ts";

const contextFixture = () => {
  const threadId = ThreadId.make("language-thread");
  const projectId = ProjectId.make("language-project");
  const now = DateTime.makeUnsafe(0);
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    title: "Boat-Umgebung prüfen",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const message = {
    text: "Bitte fasse die sichtbare Überlegung kurz zusammen. " + "x".repeat(4_000),
  } as OrchestrationV2ConversationMessage;
  const input = {
    item: { threadId, runId: RunId.make("language-run") },
    providerInstanceId: ProviderInstanceId.make("main-model"),
    driverKind: ProviderDriverKind.make("codex"),
  };
  return { threadId, projectId, thread, message, input };
};

it.effect(
  "Automatic uses bounded thread/user language evidence and a fixed project language takes precedence",
  () =>
    Effect.gen(function* () {
      const { projectId, thread, message, input } = contextFixture();
      const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () => Effect.succeed(thread),
        getRunMessage: () => Effect.succeed(message),
      });
      const resolve = yield* Service.makeContextResolver.pipe(Effect.provide(projections));
      const automatic = yield* resolve(input);
      expect(automatic?.language).toBe("auto");
      expect(automatic?.languageContext).toContain(thread.title);
      expect(automatic?.languageContext).toContain("Bitte fasse die sichtbare Überlegung");
      expect(automatic!.languageContext.length).toBeLessThanOrEqual(2_200);
      expect(Service.languageInstructions(automatic!)).toContain("user's thread language");
      expect(Service.languageInstructions(automatic!)).toContain("Do not default to English");
      const fixed = yield* Service.makeContextResolver.pipe(
        Effect.provide(
          Layer.mergeAll(
            projections,
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                toolActivityLanguage: "de",
                projectSettingsOverrides: { [projectId]: { toolActivityLanguage: "en" } },
              }),
            }),
          ),
        ),
      );
      expect((yield* fixed(input))?.language).toBe("en");
    }).pipe(Effect.scoped),
);

it.effect.each(["thread", "message", "settings", "missing message"] as const)(
  "does not replace temporarily unavailable %s context with a default model or language",
  (unavailable) =>
    Effect.gen(function* () {
      const { threadId, projectId, thread, message, input } = contextFixture();
      let available = false;
      const projectionError = new ProjectionStore.ProjectionStoreReadError({ threadId });
      const settingsError = new ServerSettingsError({
        operation: "read-file",
        settingsPath: "/fixture/settings.json",
      });
      const selected = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "project-text-model",
        options: [{ id: "serviceTier", value: "priority" }],
      };
      const configured: ServerSettingsValue = {
        ...DEFAULT_SERVER_SETTINGS,
        toolActivityLanguage: "de",
        projectSettingsOverrides: {
          [projectId]: {
            toolActivityLanguage: "auto",
            textGenerationModelSelection: selected,
          },
        },
      };
      const resolver = yield* Service.makeContextResolver.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () =>
                Effect.suspend(() =>
                  !available && unavailable === "thread"
                    ? Effect.fail(projectionError)
                    : Effect.succeed(thread),
                ),
              getRunMessage: () =>
                Effect.suspend(() =>
                  !available && unavailable === "message"
                    ? Effect.fail(projectionError)
                    : Effect.succeed(
                        !available && unavailable === "missing message" ? undefined : message,
                      ),
                ),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.suspend(() =>
                !available && unavailable === "settings"
                  ? Effect.fail(settingsError)
                  : Effect.succeed(configured),
              ),
            }),
          ),
        ),
      );
      expect(yield* resolver(input)).toBeUndefined();
      available = true;
      const context = yield* resolver(input);
      expect(context?.modelSelection).toEqual(selected);
      expect(context?.language).toBe("auto");
      expect(context?.languageContext).toContain("Boat-Umgebung prüfen");
      expect(context?.languageContext).toContain("Bitte fasse die sichtbare Überlegung");
    }).pipe(Effect.scoped),
);
