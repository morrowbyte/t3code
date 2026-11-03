import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LiveVoiceDiagnostics,
  OrchestratorMcpEnvironmentTarget,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LiveVoiceHistory from "../voice/LiveVoiceHistory.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const environmentId = EnvironmentId.make("voice-diagnostics-environment");
const threadId = ThreadId.make("voice-diagnostics-thread");
const scope: McpInvocationScope = {
  environmentId,
  requestNamespace: "client:voice-diagnostics",
  thread: undefined,
  client: { sessionId: "voice-reader", label: "Background observer", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const result: LiveVoiceDiagnostics = {
  enabled: true,
  retentionHours: 24,
  capacity: 10_000,
  events: [],
  nextAfter: 12,
  truncated: false,
  persistenceAvailable: true,
  capabilities: {
    nativeVad: false,
    actualPlayout: false,
    nativeCancel: false,
    modelContextConsumption: false,
  },
};

it("registers a read-only tool with the existing linked-environment target", () => {
  const tool = OrchestratorToolkit.tools.t3_voice_diagnostics;
  assert.isTrue(Context.getOrUndefined(tool.annotations, Tool.Readonly));
  assert.isTrue(Context.getOrUndefined(tool.annotations, Tool.Idempotent));
  assert.isFalse(Context.getOrUndefined(tool.annotations, Tool.Destructive));
  assert.equal(
    OrchestratorMcpService.OrchestratorMcpVoiceDiagnosticsInput.fields.environmentId,
    OrchestratorMcpEnvironmentTarget,
  );
});

it("bounds diagnostic tool filters and requires a thread", () => {
  const valid = Schema.is(OrchestratorMcpService.OrchestratorMcpVoiceDiagnosticsInput);
  assert.isTrue(valid({ threadId, after: 0, limit: 500, generation: 1 }));
  for (const invalid of [
    {},
    { threadId, after: -1 },
    { threadId, after: 0.5 },
    { threadId, limit: 0 },
    { threadId, limit: 501 },
    { threadId, generation: 0 },
  ])
    assert.isFalse(valid(invalid));
});

it.effect.each(["read", "capability", "environment", "missing"] as const)(
  "reads Voice diagnostics through existing thread authorization (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const shell = liveThreadShell(threadId);
      const historyReads: unknown[] = [];
      const readableThreads: unknown[] = [];
      const history = Layer.mock(LiveVoiceHistory.LiveVoiceHistory)({
        diagnostics: (target) =>
          Effect.sync(() => {
            historyReads.push(target);
            return result;
          }),
      });
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (target) =>
            Effect.succeed(scenario === "missing" ? null : target === threadId ? shell : null),
          getProjectThreadRecords: (target) =>
            Effect.sync(() => {
              readableThreads.push(target);
              return idleThreadProjection(shell);
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      );
      const service = OrchestratorMcpService.layer.pipe(Layer.provide(dependencies));
      yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const caller =
          scenario === "capability"
            ? { ...scope, capabilities: new Set<never>() }
            : scenario === "environment"
              ? { ...scope, environmentId: EnvironmentId.make("other") }
              : scope;
        const response = yield* mcp
          .voiceDiagnostics(caller, {
            threadId,
            leaseId: "call-a",
            generation: 2,
            after: 12,
            limit: 50,
          })
          .pipe(Effect.result);
        if (scenario === "read") {
          assert.equal(response._tag, "Success");
          if (response._tag === "Success") assert.deepEqual(response.success, result);
          assert.deepEqual(readableThreads, [{ projectId: shell.projectId, threadId }]);
          assert.deepEqual(historyReads, [
            { environmentId, threadId, leaseId: "call-a", generation: 2, after: 12, limit: 50 },
          ]);
        } else {
          assert.equal(response._tag, "Failure");
          if (response._tag === "Failure")
            assert.equal(
              response.failure.code,
              scenario === "missing" ? "thread_not_found" : "capability_denied",
            );
          assert.deepEqual(historyReads, []);
        }
      }).pipe(
        Effect.provide(service),
        Effect.provide(history),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("Unused descriptor"),
          }),
        ),
      );
    }),
);
