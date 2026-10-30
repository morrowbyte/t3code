import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_BOAT_PROJECT,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Clones from "../project/ProjectCloneTracker.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Boat from "./BoatService.ts";
import * as Setup from "./BoatSetupService.ts";

it.effect("replays an interrupted setup with the same project, provider and initial turn", () => {
  const projectId = ProjectId.make("setup-project");
  const calls: Launch.ThreadLaunchInput[] = [];
  let committed = false;
  let cloneFailed = false;
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const dependencies = Layer.mergeAll(
    Layer.mock(Boat.BoatService)({
      read: () =>
        Effect.succeed({
          configured: true,
          defaults: { ttlMinutes: 60, retentionDays: 14 },
          account: null,
          projects: { [projectId]: { ...DEFAULT_BOAT_PROJECT, enabled: true } },
          instances: [],
        }),
    }),
    Layer.mock(Projects.ProjectService)({
      getShell: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "New project",
            workspaceRoot: "/project",
          } as never),
        ),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(Clones.ProjectCloneTracker)({
      get: () => Effect.succeed(cloneFailed ? ({ phase: "failed" } as never) : null),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed(
          committed
            ? {
                ...liveThreadShell(ThreadId.make(`boat-setup:${projectId}`)),
                projectId,
                modelSelection,
                runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
                interactionMode: "default" as const,
              }
            : null,
        ),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          committed = true;
          if (calls.length === 1)
            return yield* new Launch.ThreadLaunchError({
              operation: "dispatch-message",
              commandId: input.commandId,
              projectId,
              threadId: input.threadId,
              cause: new Error("Reply interrupted after commit"),
            });
          return { threadId: input.threadId!, projection: {} as never, resumed: true };
        }),
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Setup.BoatSetupService;
    const error = yield* service.start({ projectId, modelSelection }).pipe(Effect.flip);
    assert.equal(error.stage, "launch");
    const resumed = yield* service.start({ projectId });
    assert.isTrue(resumed.resumed);
    assert.equal(resumed.threadId, error.threadId);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0]?.projectId, projectId);
    assert.equal(calls[0]?.workspaceStrategy.type, "root");
    assert.isAbove(calls[0]?.initialMessage?.text.length ?? 0, 0);
    cloneFailed = true;
    const cloneError = yield* service.start({ projectId }).pipe(Effect.flip);
    assert.equal(cloneError.stage, "clone");
    assert.equal(calls.length, 2);
  }).pipe(Effect.provide(Setup.layer.pipe(Layer.provide(dependencies))));
});
