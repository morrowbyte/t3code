import { CodexSettings, ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createCodexAdapterV2,
  type CodexAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../codexLaunchArgs.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { applyCodexModelCatalog } from "../codexModelCatalog.ts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { makeManagedCodexProvider } from "./CodexManagedProvider.ts";
import { makeCodexNativeAuth } from "../CodexNativeAuth.ts";
import { codexUsageReader } from "./codexUsage.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const isProviderSetupError = Schema.is(ProviderSetupError);

const DRIVER_KIND = ProviderDriverKind.make("codex");
function isCodexStandaloneCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/packages/standalone/");
}

/**
 * `codex update` replaces the standalone tree under `CODEX_HOME`. That tree
 * lives in the shared home even when an auth-overlay shadow home is in use
 * (the overlay only carries auth and a few local entries), so the updater
 * runs against `sharedHomePath` rather than the instance's effective home.
 */
function makeCodexMaintenanceResolver(sharedHomePath: string) {
  return makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isCodexStandaloneCommandPath,
      env: { CODEX_HOME: sharedHomePath },
    },
  });
}

export type CodexDriverEnv =
  | CodexAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironmentIdentity
  | CodexInstallation.CodexInstallation;

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  usage: codexUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      if (config.setupMode === "managed")
        return yield* makeManagedCodexProvider({
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const modelCatalog = yield* ModelCatalog.ModelCatalog;
      const currentCatalog = modelCatalog.current(DRIVER_KIND);
      const instancePath = environment?.findLast(
        (variable) => variable.name.toUpperCase() === "PATH",
      );
      const mergedEnvironment = yield* mergeProviderInstanceEnvironment(environment);
      const processEnv = instancePath
        ? { ...mergedEnvironment, PATH: instancePath.value }
        : mergedEnvironment;
      const homeLayout = yield* resolveCodexHomeLayout(config);
      const continuationIdentity = codexContinuationIdentity(homeLayout);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;
      const installation = yield* CodexInstallation.CodexInstallation;
      const defaultCommand = !config.binaryPath.trim() || config.binaryPath === "codex";
      const usesDefaultExecutable = defaultCommand && instancePath === undefined;
      const resolveNativeBinaryPath = Effect.gen(function* () {
        if (!defaultCommand || instancePath === undefined) return effectiveConfig.binaryPath;
        const binaryPath = yield* resolveCommandPath("codex", { env: processEnv }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        );
        if (binaryPath === null)
          return yield* new ProviderSetupError({
            instanceId,
            operation: "runtime",
            detail:
              "Codex was not found on this provider instance's PATH. Correct its PATH or configure a Codex executable.",
          });
        return binaryPath;
      });
      const setup = { canAuthenticate: true, canInstall: usesDefaultExecutable };
      const resolveRuntime = Effect.gen(function* () {
        const executable = usesDefaultExecutable ? yield* installation.acquire() : undefined;
        const binaryPath = executable?.executablePath ?? (yield* resolveNativeBinaryPath);
        yield* fileSystem
          .makeDirectory(homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath, {
            recursive: true,
          })
          .pipe(
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId,
                  operation: "runtime",
                  detail: "Could not prepare this Codex account's home directory.",
                }),
            ),
          );
        return {
          config: {
            ...effectiveConfig,
            binaryPath,
          },
          environment: processEnv,
          revision: executable ? `${executable.executablePath}:${executable.version}` : binaryPath,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isProviderSetupError(cause)
            ? cause
            : new ProviderSetupError({
                instanceId,
                operation: "install",
                detail: "Install Codex in provider settings before signing in or starting work.",
              }),
        ),
      );
      const runtimeUpgradeError = () =>
        new ProviderSetupError({
          instanceId,
          operation: "runtime",
          detail: usesDefaultExecutable
            ? "Native ChatGPT sign-in requires Codex 0.163.0 or newer. Install or update Codex in provider settings, then retry."
            : "Native ChatGPT sign-in requires Codex 0.163.0 or newer. Update the configured Codex executable, then retry.",
        });
      const checkNativeAuthRuntime = Effect.gen(function* () {
        const version = usesDefaultExecutable
          ? (yield* installation.resolve()).version
          : yield* Effect.gen(function* () {
              const command = yield* resolveSpawnCommand(
                yield* resolveNativeBinaryPath,
                ["--version"],
                { env: processEnv },
              );
              const child = yield* spawner.spawn(
                ChildProcess.make(command.command, command.args, {
                  env: processEnv,
                  shell: command.shell,
                }),
              );
              const [output, , exitCode] = yield* Effect.all(
                [
                  child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                  child.stderr.pipe(Stream.runDrain),
                  child.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              if (exitCode !== 0) return yield* runtimeUpgradeError();
              return /^codex-cli (\d+\.\d+\.\d+)$/u.exec(output.trim())?.[1] ?? "";
            }).pipe(Effect.scoped, Effect.timeout("5 seconds"));
        if (!CodexInstallation.supportsCodexDeviceAuth(version))
          return yield* runtimeUpgradeError();
      }).pipe(Effect.mapError(() => runtimeUpgradeError()));
      const auth = yield* makeCodexNativeAuth({
        instanceId,
        homePath: homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath,
        checkRuntime: checkNativeAuthRuntime,
        connect: resolveRuntime.pipe(
          Effect.flatMap((runtime) =>
            withCodexAppServerClient({
              binaryPath: runtime.config.binaryPath,
              homePath: runtime.config.homePath,
              launchArgs: resolveCodexLaunchArgs(runtime.config.launchArgs, runtime.environment),
              cwd: process.cwd(),
              environment: runtime.environment,
            }),
          ),
          Effect.flatMap((connection) =>
            CodexInstallation.supportsCodexDeviceAuth(
              connection.initialize.userAgent.match(/\/([^\s]+)/u)?.[1] ?? "",
            )
              ? Effect.succeed(connection)
              : Effect.fail(runtimeUpgradeError()),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
          Effect.mapError((cause) =>
            isProviderSetupError(cause)
              ? cause
              : new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: "Could not start Codex sign-in. Check the configured runtime.",
                }),
          ),
        ),
      });
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(
          makeCodexMaintenanceResolver(homeLayout.sharedHomePath),
          {
            binaryPath: effectiveConfig.binaryPath,
            env: processEnv,
          },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const orchestrationAdapter = yield* createCodexAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        },
        { onUsageLimits: (update) => snapshot.applyUsageLimits(update), resolveRuntime },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Codex orchestration adapter.",
              cause,
            }),
        ),
      );

      // Kick the TTL-gated manifest refresh in the background and classify with the in-memory
      // manifest, so a slow or hung fetch never delays the provider check.
      const checkProvider = modelCatalog.refreshInBackground.pipe(
        Effect.andThen(
          Effect.zipWith(
            !enabled
              ? makePendingCodexProvider(effectiveConfig)
              : resolveRuntime.pipe(
                  Effect.flatMap((runtime) =>
                    checkCodexProviderStatus(runtime.config, undefined, runtime.environment),
                  ),
                  Effect.catch(() =>
                    makePendingCodexProvider(effectiveConfig).pipe(
                      Effect.map((draft) => ({
                        ...draft,
                        message: usesDefaultExecutable
                          ? "Install Codex in provider settings to continue."
                          : "Check the configured Codex binary path in provider settings.",
                      })),
                    ),
                  ),
                  Effect.scoped,
                ),
            currentCatalog,
            (draft, catalog) => stampIdentity({ ...applyCodexModelCatalog(draft, catalog), setup }),
            { concurrent: true },
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          Effect.zipWith(
            makePendingCodexProvider(settings.provider),
            currentCatalog,
            (draft, catalog) => stampIdentity({ ...applyCodexModelCatalog(draft, catalog), setup }),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeCodexTextGeneration(
        effectiveConfig,
        processEnv,
        snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
        resolveRuntime,
      );
      yield* auth.subscribe("native-codex-snapshot").pipe(
        Stream.filter((state) =>
          ["idle", "succeeded", "failed", "cancelled"].includes(state.phase),
        ),
        Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause({ log: true }))),
        Effect.forkScoped,
      );
      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              resolveRuntime.pipe(
                Effect.flatMap((runtime) =>
                  probeCodexSkillsForCwd({
                    binaryPath: runtime.config.binaryPath,
                    homePath: runtime.config.homePath,
                    launchArgs: resolveCodexLaunchArgs(
                      runtime.config.launchArgs,
                      runtime.environment,
                    ),
                    cwd,
                    environment: runtime.environment,
                  }),
                ),
                Effect.scoped,
                Effect.timeout("20 seconds"),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              ),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: `Failed to probe Codex skills for '${cwd}'`,
                    cause,
                  }),
              ),
            );

      // Redemption spends something on the user's account. It serialises on
      // the account (instances sharing a Codex home share the credit), keeps
      // one idempotency key until Codex reports an outcome, and is bounded so
      // a hung app-server cannot hold the account lock.
      // Keyed on the directory holding auth.json: an auth-overlay instance has
      // its own account under `effectiveHomePath`, while plain instances share
      // the common home. The continuation key would conflate the two.
      const accountKey = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
        resetCreditCoordinator
          .redeem(accountKey, (idempotencyKey) =>
            Effect.gen(function* () {
              const runtime = yield* resolveRuntime;
              const { client } = yield* withCodexAppServerClient({
                binaryPath: runtime.config.binaryPath,
                homePath: runtime.config.homePath,
                launchArgs: resolveCodexLaunchArgs(runtime.config.launchArgs, runtime.environment),
                cwd: process.cwd(),
                environment: runtime.environment,
              });
              const response = yield* client.request("account/rateLimitResetCredit/consume", {
                idempotencyKey,
              });
              return response.outcome;
            }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
          )
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Codex could not redeem the reset credit.",
                  cause,
                }),
            ),
            // The windows just changed; re-probe so the snapshot says so. A
            // failed probe republishes the pre-redemption limits rather than
            // marking them failed, so "confirmed" means `checkedAt` moved past
            // what was published before the redemption started.
            Effect.tap((outcome) =>
              Effect.gen(function* () {
                const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
                const refreshed = yield* snapshot.refresh;
                const after = refreshed.usageLimits?.checkedAt;
                if (
                  outcome === "reset" &&
                  (after === undefined ||
                    after === before ||
                    refreshed.usageLimits?.unavailable?.reason === "probeFailed")
                ) {
                  return yield* new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail:
                      "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
                  });
                }
              }),
            ),
          );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        consumeResetCredit,
        orchestrationAdapter,
        textGeneration,
        auth,
      } satisfies ProviderInstance;
    }),
};
