import {
  ServerSelfUpdateError,
  HostUpdateHistoryError,
  type DeleteHostUpdateInput,
  type HostUpdateHistory,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { updateHistoryUuid } from "@t3tools/shared/updateHistory";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
  prunePinnedRuntimes,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import { makeServerUpdateHistory } from "./updateHistory.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as Crypto from "effect/Crypto";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly history?: {
      readonly list: Effect.Effect<HostUpdateHistory, HostUpdateHistoryError>;
      readonly remove: (
        input: typeof DeleteHostUpdateInput.Type,
      ) => Effect.Effect<void, HostUpdateHistoryError>;
    };
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export const withRunningThreadContinuation = Effect.fn(
  "cloud.server_self_update.withRunningThreadContinuation",
)(function* (input: {
  readonly mode: ServerConfig.RuntimeMode;
  readonly selfUpdate: ServerSelfUpdate["Service"];
  readonly prepare: Effect.Effect<ReadonlyArray<ThreadId>, ServerSelfUpdateError>;
  readonly clear: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<void, ServerSelfUpdateError>;
}) {
  const desktopContinuationTokens = yield* Ref.make(HashSet.empty<string>());
  const clearOnError = <A>(
    effect: Effect.Effect<A, ServerSelfUpdateError>,
    threadIds: () => ReadonlyArray<ThreadId>,
    handoffAccepted: () => boolean,
  ): Effect.Effect<A, ServerSelfUpdateError> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        (handoffAccepted() && Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : input.clear(threadIds())
        ).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );

  const update: ServerSelfUpdate["Service"]["update"] = (
    request,
    reportProgress = () => Effect.void,
  ) => {
    let prepared = false;
    let handoffAccepted = false;
    let continuationThreadIds: ReadonlyArray<ThreadId> = [];
    return clearOnError(
      input.selfUpdate
        .update(
          request,
          (stage) =>
            (request.continueRunningThreads === true &&
            input.mode !== "desktop" &&
            stage === "installing" &&
            !prepared
              ? input.prepare.pipe(
                  Effect.tap((threadIds) =>
                    Effect.sync(() => {
                      prepared = true;
                      continuationThreadIds = threadIds;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void
            ).pipe(Effect.andThen(reportProgress(stage))),
          () =>
            Effect.sync(() => {
              handoffAccepted = true;
            }),
        )
        .pipe(
          Effect.tap((result) => {
            if (
              result.method === "desktop-app" &&
              result.desktopUpdateToken !== undefined &&
              request.continueRunningThreads === true
            ) {
              return Ref.update(desktopContinuationTokens, HashSet.add(result.desktopUpdateToken));
            }
            return Effect.void;
          }),
        ),
      () => continuationThreadIds,
      () => handoffAccepted,
    );
  };

  return ServerSelfUpdate.of({
    ...input.selfUpdate,
    update,
    commitDesktopUpdate: Effect.fn("selfUpdate.commitDesktopUpdate")(function* (requestId) {
      const shouldContinue = yield* Ref.modify(desktopContinuationTokens, (tokens) => [
        HashSet.has(tokens, requestId),
        HashSet.remove(tokens, requestId),
      ]);
      let handoffAccepted = false;
      let continuationThreadIds: ReadonlyArray<ThreadId> = [];
      return yield* clearOnError(
        Effect.gen(function* () {
          continuationThreadIds = shouldContinue ? yield* input.prepare : [];
          return yield* input.selfUpdate.commitDesktopUpdate(requestId, () =>
            Effect.sync(() => {
              handoffAccepted = true;
            }),
          );
        }),
        () => continuationThreadIds,
        () => handoffAccepted,
      ).pipe(
        Effect.catchCause((cause) =>
          (shouldContinue && !handoffAccepted
            ? Ref.update(desktopContinuationTokens, HashSet.add(requestId))
            : Effect.void
          ).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
    }),
  });
});

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const httpClient = yield* HttpClient.HttpClient;
  const receiver = yield* Effect.serviceOption(DesktopTelemetryReceiver.DesktopTelemetryReceiver);
  const crypto = yield* Crypto.Crypto;
  const history = yield* makeServerUpdateHistory(serverConfig.baseDir, packageJson.version);
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const inFlight = yield* Ref.make(false);

  // A managed server starting means its launcher has settled on a version, so runtimes left by
  // earlier updates can go.
  if (launcher.managed) {
    yield* prunePinnedRuntimes({ baseDir: serverConfig.baseDir, keep: [packageJson.version] }).pipe(
      Effect.tap((removed) =>
        removed.length === 0
          ? Effect.void
          : Effect.logInfo("Removed unused t3 runtimes.", { versions: removed }),
      ),
      Effect.forkScoped,
    );
  }

  const capability: ServerSelfUpdateCapability | null = resolveServerSelfUpdateCapability({
    desktopManaged: desktopAppUpdate.available,
    launcherManaged: launcher.managed,
  });
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void, onHandoffAccepted = () => Effect.void) {
    if (capability === "desktop-managed") {
      if (desktopAppUpdate.available) {
        return yield* desktopAppUpdate.run(reportProgress);
      }
      return yield* failWith(
        "This server is managed by the T3 Code desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    yield* history.recover.pipe(
      Effect.mapError((error) => failWith(error.message)),
      Effect.onError(() => Ref.set(inFlight, false)),
    );
    const attemptId = yield* history.start("server", packageJson.version, targetVersion).pipe(
      Effect.mapError((error) => failWith(error.message)),
      Effect.onError(() => Ref.set(inFlight, false)),
    );
    let handoffAccepted = false;
    return yield* Effect.gen(function* () {
      yield* reportProgress("downloading");
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        httpClient,
        platform,
        arch,
        releaseBaseUrl,
        validate: (runtime) =>
          runner
            .run({
              command: pinnedRuntimeCommand(runtime).command,
              args: [
                ...pinnedRuntimeCommand(runtime).args,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              timeout: PREFLIGHT_TIMEOUT,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({
                    step: "running the staged service preflight",
                    cause,
                  }),
              ),
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
                > => {
                  if (result.code !== 0) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "running the staged service preflight",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      }),
                    );
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(result.stdout.trim());
                  } catch (cause) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "decoding the staged service preflight",
                        cause,
                      }),
                    );
                  }
                  const preflight = decodeServicePreflightResult(parsed);
                  if (preflight === undefined || preflight.version !== targetVersion) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "verifying the staged service preflight",
                      }),
                    );
                  }
                  return preflight.status === "ready"
                    ? Effect.void
                    : Effect.fail(
                        new PinnedRuntimePreflightBlockedError({
                          version: targetVersion,
                          reason: preflight.reason,
                        }),
                      );
                },
              ),
            ),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : failWith(`Could not prepare t3@${targetVersion}.`, error),
        ),
      );

      yield* reportProgress("installing");
      yield* history
        .patch(attemptId, "installing")
        .pipe(Effect.mapError((error) => failWith(error.message)));
      const updateId = yield* Effect.uninterruptible(
        launcher.requestUpdate({ targetVersion, dbPath: serverConfig.dbPath }).pipe(
          Effect.mapError((error) =>
            failWith(
              error._tag === "ServiceLauncherRejectedError"
                ? error.reason
                : "Could not ask the service launcher to activate the prepared update.",
              error,
            ),
          ),
          Effect.tap((receiptId) =>
            history
              .patch(attemptId, "awaiting-restart", { receiptId })
              .pipe(Effect.mapError((error) => failWith(error.message))),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              handoffAccepted = true;
            }),
          ),
          Effect.tap(() => onHandoffAccepted()),
        ),
      );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          if (!handoffAccepted || !Cause.hasInterruptsOnly(cause)) {
            yield* history
              .patch(attemptId, Cause.hasInterruptsOnly(cause) ? "interrupted" : "failed", {
                observedVersion: packageJson.version,
                error: Cause.hasInterruptsOnly(cause)
                  ? "Update preparation was interrupted. Check the running version before retrying."
                  : Option.match(Cause.findErrorOption(cause), {
                      onNone: () =>
                        "Update preparation failed. Check service logs before retrying.",
                      onSome: (error) => error.message,
                    }),
              })
              .pipe(Effect.ignore);
          }
          yield* Ref.set(inFlight, false);
        }),
      ),
    );
  });

  const desktopHistory = (deleteId?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (Option.isNone(receiver) || receiver.value.requestDesktopUpdateHistory === undefined)
          return yield* new HostUpdateHistoryError({
            reason:
              "The desktop host is unavailable. Reconnect before reading or deleting its history.",
          });
        const requestId = yield* updateHistoryUuid(crypto).pipe(
          Effect.mapError(
            () => new HostUpdateHistoryError({ reason: "Could not create a history request." }),
          ),
        );
        const { changes } = yield* receiver.value.desktopUpdates;
        yield* receiver.value
          .requestDesktopUpdateHistory(requestId, deleteId)
          .pipe(
            Effect.mapError(
              () => new HostUpdateHistoryError({ reason: "Could not reach the desktop host." }),
            ),
          );
        const reply = yield* changes.pipe(
          Stream.filter(
            (report) =>
              report.requestId === requestId &&
              (report.history !== undefined || report.historyError !== undefined),
          ),
          Stream.runHead,
          Effect.timeoutOption("10 seconds"),
        );
        if (Option.isNone(reply) || Option.isNone(reply.value))
          return yield* new HostUpdateHistoryError({
            reason:
              "The desktop host did not confirm the history request. Refresh to check the result.",
          });
        const report = reply.value.value;
        const error = report.historyError ?? report.state.updateHistoryError;
        if (error) return yield* new HostUpdateHistoryError({ reason: error });
        return report.history ?? [];
      }),
    );

  return ServerSelfUpdate.of({
    history: {
      list: Effect.gen(function* () {
        const entries = yield* history.list;
        if (!desktopAppUpdate.available) return { entries, desktop: "not-applicable" as const };
        return yield* desktopHistory().pipe(
          Effect.map((desktopEntries) => ({
            entries: [...entries, ...desktopEntries].sort((a, b) =>
              b.updatedAt.localeCompare(a.updatedAt),
            ),
            desktop: "available" as const,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              entries,
              desktop: "unavailable" as const,
              desktopError: error.message,
            }),
          ),
        );
      }),
      remove: (input) =>
        input.component === "server"
          ? history.remove(input.id)
          : desktopHistory(input.id).pipe(Effect.asVoid),
    },
    update,
    commitDesktopUpdate: (requestId, onHandoffAccepted) =>
      desktopAppUpdate.commit(requestId, onHandoffAccepted),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);

// The RPC stream used to own this fiber, so a dropped client socket interrupted
// the download. Offers after the queue shuts down are ignored; the update
// still finishes, and the in-flight guard stays as it was.
export const updateProgressStream = (
  selfUpdate: ServerSelfUpdate["Service"],
  input: ServerSelfUpdateInput,
) =>
  Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) => {
    const offer = (event: ServerSelfUpdateProgressEvent) =>
      Queue.offer(queue, event).pipe(Effect.ignore);

    return selfUpdate
      .update(input, (stage) => offer({ type: "progress", stage }))
      .pipe(
        Effect.flatMap((result) => offer({ type: "complete", result })),
        Effect.catchTags({
          ServerSelfUpdateError: (error) => Queue.fail(queue, error).pipe(Effect.ignore),
        }),
        Effect.andThen(Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkDetach,
      );
  });
