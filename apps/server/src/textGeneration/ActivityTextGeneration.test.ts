import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
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

it.effect(
  "Automatic uses bounded thread/user language evidence and a fixed project language takes precedence",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("language-thread");
      const projectId = ProjectId.make("language-project");
      const now = DateTime.makeUnsafe(0);
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId,
        title: "Werkzeugbeschriftungen verbessern",
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
      const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () => Effect.succeed(thread),
        getRunMessage: () => Effect.succeed(message),
      });
      const resolve = yield* Service.makeContextResolver.pipe(Effect.provide(projections));
      const input = {
        item: { threadId, runId: RunId.make("language-run") },
        providerInstanceId: ProviderInstanceId.make("main-model"),
        driverKind: ProviderDriverKind.make("codex"),
      };
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
