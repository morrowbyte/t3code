// @effect-diagnostics nodeBuiltinImport:off -- Bridges the standalone restore controller to Electron lifecycle callbacks.
import * as DesktopRestoreStore from "@t3tools/shared/desktopRestore";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";

const { logWarning } = makeComponentLogger("desktop-restore");
const decodePackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      t3codeRestore: Schema.optionalKey(DesktopRestoreStore.DesktopRestoreBuild),
    }),
  ),
);

const optionalRestoreSetting = (name: string) =>
  Config.String(name).pipe(Config.withDefault(undefined));

const RestoreConfig = Config.all({
  nixUpdaterPath: optionalRestoreSetting("T3CODE_NIX_UPDATER"),
  nixDataDir: optionalRestoreSetting("T3CODE_NIX_DATA_DIR"),
  legacyNixDataDir: optionalRestoreSetting("T3_MORROWBYTE_DATA_DIR"),
  xdgDataHome: optionalRestoreSetting("XDG_DATA_HOME"),
  nixLauncherPath: optionalRestoreSetting("T3CODE_NIX_LAUNCHER"),
  maxVersions: optionalRestoreSetting("T3CODE_DESKTOP_RESTORE_MAX_VERSIONS"),
  maxBytes: optionalRestoreSetting("T3CODE_DESKTOP_RESTORE_MAX_BYTES"),
});

class DesktopRestoreOperationError extends Schema.TaggedError<
  DesktopRestoreOperationError,
  { readonly brand: unique symbol }
>()("DesktopRestoreOperationError", {
  operation: Schema.Literals(["register", "close-session", "mark-healthy"]),
  cause: Schema.Defect(),
}) {}

export const observe = Effect.fn("DesktopRestore.observe")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged || environment.platform !== "linux") return;
  const nixUpdaterPath = yield* optionalRestoreSetting("T3CODE_NIX_UPDATER").pipe(Effect.option);
  if (Option.isNone(nixUpdaterPath)) {
    yield* logWarning("Desktop restore configuration failed; restore remains unavailable.");
    return;
  }
  if (Option.isNone(environment.appImagePath) && !nixUpdaterPath.value) return;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const state = yield* DesktopState.DesktopState;
  const context = yield* Effect.context<never>();
  let session: (() => Promise<void>) | undefined;
  const register = RestoreConfig.pipe(
    Effect.flatMap((config) =>
      Effect.tryPromise({
        try: async () => {
          const Electron = await import("electron");
          const metadata = decodePackage(
            await NodeFSP.readFile(NodePath.join(environment.appPath, "package.json"), "utf8"),
          );
          const build = metadata.t3codeRestore;
          if (build === undefined) return;
          if (build.version !== environment.appVersion)
            throw new Error("Restore build metadata version mismatch.");
          const baseDir = await NodeFSP.realpath(environment.baseDir);
          const nixDataDir = config.nixUpdaterPath
            ? await NodeFSP.realpath(
                config.nixDataDir ??
                  config.legacyNixDataDir ??
                  NodePath.join(
                    config.xdgDataHome ??
                      NodePath.join(environment.homeDirectory, ".local", "share"),
                    "t3code-morrowbyte",
                  ),
              )
            : null;
          const appImage = Option.getOrUndefined(environment.appImagePath);
          const identity: DesktopRestoreStore.DesktopRestoreIdentity = {
            kind: nixDataDir === null ? "appimage" : "nix",
            baseDir,
            installPath:
              nixDataDir === null
                ? await NodeFSP.realpath(appImage!)
                : NodePath.join(nixDataDir, "current"),
            launcherPath:
              nixDataDir === null
                ? await NodeFSP.realpath(appImage!)
                : (config.nixLauncherPath ?? ""),
            stateDir: await NodeFSP.realpath(environment.stateDir),
            userDataDir: await NodeFSP.realpath(Electron.app.getPath("userData")),
            profileId: Option.getOrNull(environment.profileId),
            environmentId: (
              await NodeFSP.readFile(NodePath.join(environment.stateDir, "environment-id"), "utf8")
            ).trim(),
            updaterPath:
              nixDataDir === null
                ? null
                : NodePath.join(nixDataDir, "current", "libexec", "t3code-morrowbyte-update"),
            nixDataDir,
          };
          await DesktopRestoreStore.registerDesktopRestoreBuild({
            baseDir,
            identity,
            build,
            ...(config.maxVersions ? { maxVersions: Number(config.maxVersions) } : {}),
            ...(config.maxBytes ? { maxBytes: Number(config.maxBytes) } : {}),
          });
          if (session === undefined)
            session = await DesktopRestoreStore.startDesktopRestoreSession({
              baseDir,
              appDataDirectory: environment.appDataDirectory,
              passwordStore: Electron.app.commandLine.hasSwitch("password-store")
                ? Electron.app.commandLine.getSwitchValue("password-store")
                : null,
              quiesce: () =>
                Effect.runPromiseWith(context)(
                  Effect.gen(function* () {
                    if (yield* Ref.get(state.quitting))
                      return yield* Effect.die(new Error("Desktop is already quitting."));
                    yield* Ref.set(state.quitting, true);
                    const instances = yield* pool.list;
                    yield* Effect.forEach(
                      instances,
                      (instance) => instance.stop({ timeout: Duration.seconds(5) }),
                      { concurrency: "unbounded" },
                    );
                  }),
                ),
              quit: () => Electron.app.quit(),
            });
          return { baseDir, identity, build };
        },
        catch: (cause) => new DesktopRestoreOperationError({ operation: "register", cause }),
      }),
    ),
    Effect.catch(() =>
      logWarning(
        "Desktop restore registration or health verification failed; restore remains unavailable.",
      ),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise({
      try: async () => {
        await session?.();
      },
      catch: (cause) => new DesktopRestoreOperationError({ operation: "close-session", cause }),
    }).pipe(Effect.ignore),
  );
  const registration = yield* register;
  yield* SubscriptionRef.changes(state.primaryBackendStartup).pipe(
    Stream.filter((startup) => startup._tag === "Ready"),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const current = registration ?? (yield* register);
        if (current === undefined) return;
        yield* Effect.tryPromise({
          try: () => DesktopRestoreStore.markDesktopRestoreHealthy(current),
          catch: (cause) => new DesktopRestoreOperationError({ operation: "mark-healthy", cause }),
        }).pipe(
          Effect.catch(() => logWarning("Desktop restore runtime health verification failed.")),
        );
      }),
    ),
    Effect.forkScoped,
  );
});
