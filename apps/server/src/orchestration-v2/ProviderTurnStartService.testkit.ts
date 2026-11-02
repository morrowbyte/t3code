import {
  DEFAULT_BOAT_DEFAULTS,
  type Project,
  type ProjectId,
  SourceControlProviderError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { HostResources } from "../resourceTelemetry/HostResources.ts";
import { BoatService } from "../boat/BoatService.ts";
import * as PortScanner from "../preview/PortScanner.ts";

export function layerForProject(projectId: ProjectId, cwd: string) {
  const project: Project = {
    id: projectId,
    title: "Replay fixture",
    workspaceRoot: cwd,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
  return Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  });
}

export const layerCompute = Layer.mergeAll(
  Layer.succeed(HostResources, {
    read: Effect.succeed({
      sampledAt: 0,
      cpuUtilization: 0.1,
      cpuCount: 8,
      availableMemoryBytes: 16 * 1024 ** 3,
      totalMemoryBytes: 32 * 1024 ** 3,
    }),
  }),
  Layer.mock(BoatService)({
    isEnabled: () => Effect.succeed(false),
    read: () =>
      Effect.succeed({
        configured: false,
        defaults: DEFAULT_BOAT_DEFAULTS,
        account: null,
        projects: {},
        instances: [],
      }),
  }),
);

export const layer = Layer.mergeAll(
  layerCompute,
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedNone,
  }),
);

// Keep repository detection, branch selection and worktree creation on the real Git path.
export const layerRealGit = GitWorkflow.layer.pipe(
  Layer.provide(GitManager.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        resolve: ({ cwd }) =>
          Effect.fail(
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("unknown"),
              operation: "resolve",
              cwd,
              detail: "No source control provider in tests",
            }),
          ),
      }),
      Layer.mock(TextGeneration.TextGeneration)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      ServerSettings.layerTest(),
    ),
  ),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-recreate-" })),
  Layer.provideMerge(NodeServices.layer),
);
