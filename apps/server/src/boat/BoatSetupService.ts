import {
  BoatSetupError,
  type BoatSetupInput,
  type BoatSetupResult,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import {
  resolveNewThreadModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "@t3tools/shared/usageLimits";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Clones from "../project/ProjectCloneTracker.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Boat from "./BoatService.ts";
import { boatSetupPrompt } from "./setupPrompt.ts";

export class BoatSetupService extends Context.Service<
  BoatSetupService,
  { readonly start: (input: BoatSetupInput) => Effect.Effect<BoatSetupResult, BoatSetupError> }
>()("t3/boat/BoatSetupService") {}

export const layer = Layer.effect(
  BoatSetupService,
  Effect.gen(function* () {
    const boat = yield* Boat.BoatService;
    const projects = yield* Projects.ProjectService;
    const settings = yield* Settings.ServerSettingsService;
    const providers = yield* Providers.ProviderRegistry;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* Threads.ThreadManagementService;
    const clones = yield* Clones.ProjectCloneTracker;
    return {
      start: Effect.fn("BoatSetupService.start")(function* (input: BoatSetupInput) {
        const threadId = ThreadId.make(`boat-setup:${input.projectId}`);
        const fail = (stage: BoatSetupError["stage"]) => (cause: unknown) =>
          new BoatSetupError({ projectId: input.projectId, threadId, stage, cause });
        const project = yield* projects
          .getShell(input.projectId)
          .pipe(Effect.mapError(fail("project")));
        if (Option.isNone(project)) return yield* fail("project")(null);
        let clone = yield* clones.get(input.projectId);
        if (clone?.phase === "running") {
          const finished = yield* clones.stream.pipe(
            Stream.map((items) => items.find((item) => item.projectId === input.projectId)),
            Stream.filter((item) => item?.phase !== "running"),
            Stream.runHead,
          );
          clone = Option.getOrUndefined(finished) ?? null;
        }
        if (clone && clone.phase !== "done") return yield* fail("clone")(null);
        const state = yield* boat.read(input.projectId).pipe(Effect.mapError(fail("boat")));
        if (!state.configured || !state.projects[input.projectId]?.enabled)
          return yield* fail("boat")(null);
        const existing = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(fail("launch")));
        if (existing && existing.projectId !== input.projectId) return yield* fail("project")(null);
        const serverSettings = yield* settings.getSettings.pipe(Effect.mapError(fail("provider")));
        const availableProviders = yield* providers.getProviders;
        const defaults = resolveProjectSettings(
          serverSettings,
          input.projectId,
          project.value,
        ).settings;
        const modelSelection =
          existing?.modelSelection ??
          input.modelSelection ??
          resolveNewThreadModelSelection({
            defaultSelection:
              defaults.defaultModelSelection ??
              resolveProjectDefaultProviderModelSelection(
                availableProviders,
                serverSettings,
                input.projectId,
              ),
            fallbackSelection: defaults.fallbackModelSelection,
            providers: availableProviders,
            settings: defaults,
            projectId: input.projectId,
            now: DateTime.toEpochMillis(yield* DateTime.now),
          }).selection;
        if (!modelSelection) return yield* fail("provider")(null);
        const result = yield* launches
          .launch({
            commandId: CommandId.make(`boat-setup:${input.projectId}`),
            threadId,
            projectId: input.projectId,
            title: "Set up Boat development",
            modelSelection,
            runtimeMode: existing?.runtimeMode ?? defaults.defaultRuntimeMode,
            interactionMode: existing?.interactionMode ?? "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`boat-setup:${input.projectId}`),
              text: boatSetupPrompt(input.projectId),
              attachments: [],
            },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(Effect.mapError(fail("launch")));
        return { threadId: result.threadId, resumed: result.resumed };
      }),
    };
  }),
);
