// @effect-diagnostics nodeBuiltinImport:off -- Bridges the standalone restore controller to Electron lifecycle callbacks.
import * as DesktopRestoreStore from "@t3tools/shared/desktopRestore";
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
const decodeBuild = Schema.decodeUnknownSync(DesktopRestoreStore.DesktopRestoreBuild);

export const observe = Effect.fn("DesktopRestore.observe")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (
    !environment.isPackaged ||
    environment.platform !== "linux" ||
    (Option.isNone(environment.appImagePath) && !process.env.T3CODE_NIX_UPDATER)
  )
    return;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const state = yield* DesktopState.DesktopState;
  const context = yield* Effect.context<never>();
  let session: (() => Promise<void>) | undefined;
  const register = Effect.tryPromise(async () => {
    const Electron = await import("electron");
    const metadata: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(environment.appPath, "package.json"), "utf8"),
    );
    if (typeof metadata !== "object" || metadata === null || !("t3codeRestore" in metadata)) return;
    const build = decodeBuild(metadata.t3codeRestore);
    if (build.version !== environment.appVersion)
      throw new Error("Restore build metadata version mismatch.");
    const baseDir = await NodeFSP.realpath(environment.baseDir);
    const nixDataDir = process.env.T3CODE_NIX_UPDATER
      ? await NodeFSP.realpath(
          process.env.T3CODE_NIX_DATA_DIR ??
            process.env.T3_MORROWBYTE_DATA_DIR ??
            NodePath.join(
              process.env.XDG_DATA_HOME ??
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
          : (process.env.T3CODE_NIX_LAUNCHER ?? ""),
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
      ...(process.env.T3CODE_DESKTOP_RESTORE_MAX_VERSIONS
        ? { maxVersions: Number(process.env.T3CODE_DESKTOP_RESTORE_MAX_VERSIONS) }
        : {}),
      ...(process.env.T3CODE_DESKTOP_RESTORE_MAX_BYTES
        ? { maxBytes: Number(process.env.T3CODE_DESKTOP_RESTORE_MAX_BYTES) }
        : {}),
    });
    if (session === undefined)
      session = await DesktopRestoreStore.startDesktopRestoreSession({
        baseDir,
        quiesce: () =>
          Effect.runPromiseWith(context)(
            Effect.gen(function* () {
              if (yield* Ref.get(state.quitting))
                return yield* Effect.dieMessage("Desktop is already quitting.");
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
    await DesktopRestoreStore.markDesktopRestoreHealthy({ baseDir, identity, build });
  }).pipe(
    Effect.catch(() =>
      logWarning(
        "Desktop restore registration or health verification failed; restore remains unavailable.",
      ),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(async () => {
      await session?.();
    }).pipe(Effect.ignore),
  );
  yield* SubscriptionRef.changes(state.primaryBackendStartup).pipe(
    Stream.filter((startup) => startup._tag === "Ready"),
    Stream.runForEach(() => register),
    Effect.forkScoped,
  );
});
