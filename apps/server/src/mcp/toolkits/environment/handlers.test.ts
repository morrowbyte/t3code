import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect(
  "updates and reads the selected preference scope without changing environment defaults",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:preferences");
      const toolkit = yield* EnvironmentToolkit;
      const settings = yield* Settings.ServerSettingsService;
      const preference = {
        key: "answer-format",
        text: "Answer briefly in German.",
        source: "thread:confirmation/message:format",
        appliesTo: { kind: "preference" as const },
        status: "active" as const,
      };
      yield* toolkit
        .handle("t3_environment_preferences_update", {
          agentPreferences: { projectId: null, entries: [preference] },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      yield* toolkit
        .handle("t3_environment_preferences_update", {
          agentPreferences: {
            projectId,
            entries: [
              {
                ...preference,
                text: "Answer in English.",
                source: "thread:confirmation/message:correction",
              },
            ],
          },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      const current = yield* settings.getSettings;
      expect(current.agentPreferences).toEqual([preference]);
      expect(current.projectSettingsOverrides[projectId]?.branchNamePrefix).toBe("task");
      expect(current.projectSettingsOverrides[projectId]?.agentPreferences?.[0]?.replaces).toEqual({
        text: preference.text,
        source: preference.source,
      });
      const read = yield* toolkit
        .handle("t3_environment_read", { projectId })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(read.at(-1)?.result).toMatchObject({
        preferences: {
          agentPreferences: [
            { text: "Answer in English.", source: "thread:confirmation/message:correction" },
          ],
        },
      });
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ThreadCommandExecutor.layer,
              Settings.layerTest({
                projectSettingsOverrides: {
                  [ProjectId.make("project:preferences")]: { branchNamePrefix: "task" },
                },
              }),
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId,
                requestNamespace: "provider:preferences",
                thread: {
                  threadId,
                  providerSessionId: "provider:preferences",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration" as const]),
                issuedAt: 0,
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
              }),
              Layer.mock(Environment.ServerEnvironment)({
                getDescriptor: Effect.succeed({
                  environmentId,
                  label: "Test",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "0.0.0",
                  capabilities: { repositoryIdentity: false },
                }),
              }),
            ),
          ),
        ),
      ),
    ),
);

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
