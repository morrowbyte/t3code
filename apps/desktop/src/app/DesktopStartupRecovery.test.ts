// @effect-diagnostics nodeBuiltinImport:off -- models Electron navigation events at the recovery shell boundary.
import { it as effectIt } from "@effect/vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Electron from "electron";
import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import { listen, resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

describe("resolveStartupRecoveryOffer", () => {
  it("offers a newer version before going back", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("offers a retained download after a later check fails", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "error", errorContext: "check", downloadedVersion: "0.1.4" }),
        null,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("waits for the update check before offering to go back", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "checking" }), "0.1.2")).toEqual({
      _tag: "Checking",
    });
  });

  it("offers the last version that started when no update exists", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2")).toEqual({
      _tag: "Reinstall",
      version: "0.1.2",
    });
  });

  it("does not offer an update that already failed to apply here", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({
          status: "downloaded",
          downloadedVersion: "0.1.4",
          notAppliedVersion: "0.1.4",
        }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Reinstall", version: "0.1.2" });
  });

  it("blames the managed policy unless a newer version can read it", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
        true,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
    expect(
      resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2", true),
    ).toEqual({ _tag: "ManagedPolicy" });
  });

  it("falls back to the releases page when this version never started", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "disabled" }), "0.1.3")).toEqual({
      _tag: "Releases",
    });
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), null)).toEqual({
      _tag: "Releases",
    });
  });
});

effectIt.effect.each([
  {
    action: "reinstall",
    lastStartedVersion: "0.1.8-nightly.20261109.109",
    expected: "https://github.com/morrowbyte/t3code/releases/tag/v0.1.8-nightly.20261109.109",
  },
  {
    action: "releases",
    lastStartedVersion: null,
    expected: "https://github.com/morrowbyte/t3code/releases",
  },
])("opens $action in the fork's release repository after startup fails", (testCase) =>
  Effect.gen(function* () {
    const rendered = yield* Deferred.make<void>();
    const opened = yield* Deferred.make<unknown>();
    const webContents = Object.assign(new NodeEvents.EventEmitter(), {
      setWindowOpenHandler: () => {},
    });
    const window = {
      webContents,
      isDestroyed: () => false,
      once: () => {},
      loadURL: () => {
        Deferred.doneUnsafe(rendered, Effect.void);
        return Promise.resolve();
      },
    } as unknown as Electron.BrowserWindow;
    const path = yield* Path.Path.pipe(Effect.provide(Path.layer));
    const quitting = yield* Ref.make(false);
    const backendReady = yield* Ref.make(false);
    const primaryBackendStartup = yield* SubscriptionRef.make<DesktopState.PrimaryBackendStartup>({
      _tag: "Failing",
      reason: "The backend could not start after updating.",
      managedPolicy: false,
      output: "Backend startup failed.",
    });
    const state = updateState({
      currentVersion: "0.1.10-nightly.20261112.4580",
      enabled: false,
      status: "disabled",
    });
    const layer = Layer.mergeAll(
      Layer.mock(DesktopState.DesktopState, { primaryBackendStartup, quitting, backendReady }),
      DesktopEnvironment.layer({
        appVersion: state.currentVersion,
        dirname: "/qa/app/apps/desktop/dist-electron",
        homeDirectory: "/qa",
        appPath: "/qa/app",
        resourcesPath: "/qa/app/resources",
        isPackaged: false,
        runningUnderArm64Translation: false,
        platform: "linux",
        processArch: "x64",
      }).pipe(
        Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: "/qa/profile" })),
        Layer.provide(Layer.succeed(Path.Path, path)),
      ),
      Layer.mock(DesktopUpdates.DesktopUpdates, {
        subscribe: Effect.succeed({ latest: state, changes: Stream.never }),
        check: () => Effect.succeed({ checked: false, state }),
      }),
      Layer.mock(ElectronApp.ElectronApp, { on: () => Effect.void }),
      Layer.mock(ElectronShell.ElectronShell, {
        openExternal: (url) => Deferred.succeed(opened, url).pipe(Effect.as(true)),
      }),
      Layer.mock(ElectronTheme.ElectronTheme, { shouldUseDarkColors: Effect.succeed(false) }),
      Layer.mock(ElectronWindow.ElectronWindow, {
        main: Effect.succeedNone,
        create: () => Effect.succeed(window),
      }),
      FileSystem.layerNoop({
        readFileString: () => Effect.succeed(testCase.lastStartedVersion ?? ""),
      }),
    );

    yield* listen.pipe(Effect.provide(layer));
    yield* Deferred.await(rendered);
    const preventDefault = vi.fn();
    webContents.emit(
      "will-navigate",
      { preventDefault },
      `https://startup-recovery.invalid/${testCase.action}`,
    );
    expect(yield* Deferred.await(opened)).toBe(testCase.expected);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);

effectIt.effect.each([
  { visible: false, started: false, closeMain: false },
  { visible: true, started: false, closeMain: false },
  { visible: true, started: true, closeMain: false },
  { visible: true, started: false, closeMain: true },
])("closes recovery safely with closeMain=$closeMain", ({ visible, started, closeMain }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const checked = yield* Deferred.make<void>();
      const remembered = yield* Deferred.make<void>();
      const shouldRecover = !visible || !started;
      const closed = Promise.withResolvers<void>();
      const loaded: string[] = [];
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const mainListeners = new Map<string, () => void>();
      let closeCount = 0;
      let mainVisible = visible;
      const main = {
        isDestroyed: () => false,
        isVisible: () => mainVisible,
        on: (event: string, listener: () => void) => mainListeners.set(event, listener),
        once: (event: string, listener: () => void) => mainListeners.set(event, listener),
      } as unknown as Electron.BrowserWindow;
      const mainRef = yield* Ref.make(Option.some(main));
      const recovery = {
        isDestroyed: () => false,
        close: () => {
          closeCount++;
          closed.resolve();
        },
        loadURL: (url: string) => {
          loaded.push(url);
          return Promise.resolve();
        },
        once: () => {},
        webContents: { setWindowOpenHandler: () => {}, on: () => {} },
      } as unknown as Electron.BrowserWindow;
      const state = yield* DesktopState.DesktopState;
      if (started) yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
      yield* listen.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              readFileString: () => Effect.succeed("0.1.2"),
              writeFileString: () => Deferred.succeed(remembered, undefined).pipe(Effect.asVoid),
            }),
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              appVersion: "0.1.3",
              stateDir: "/task/state",
              logDir: "/task/logs",
              path: { join: (...parts: string[]) => parts.join("/") },
            } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.succeed(ElectronApp.ElectronApp, {
              on: (event: string, listener: (...args: readonly unknown[]) => void) =>
                Effect.sync(() => {
                  appListeners.set(event, listener);
                }),
            } as unknown as ElectronApp.ElectronApp["Service"]),
            Layer.succeed(
              ElectronShell.ElectronShell,
              {} as ElectronShell.ElectronShell["Service"],
            ),
            Layer.succeed(ElectronTheme.ElectronTheme, {
              shouldUseDarkColors: Effect.succeed(false),
            } as ElectronTheme.ElectronTheme["Service"]),
            Layer.succeed(ElectronWindow.ElectronWindow, {
              main: Ref.get(mainRef),
              create: () => Effect.succeed(recovery),
            } as unknown as ElectronWindow.ElectronWindow["Service"]),
            Layer.succeed(DesktopUpdates.DesktopUpdates, {
              subscribe: Effect.succeed({
                latest: updateState({ status: "disabled" }),
                changes: Stream.empty,
              }),
              check: () => Deferred.succeed(checked, undefined),
            } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
          ),
        ),
      );
      appListeners.get("browser-window-created")?.({}, main);
      if (started) yield* Deferred.await(remembered);
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "Server failed before readiness",
        managedPolicy: false,
        output: "Failure details",
      });
      yield* Deferred.await(checked);
      expect(loaded.length).toBe(shouldRecover ? 1 : 0);
      if (shouldRecover) {
        expect(decodeURIComponent(loaded[0]!)).toContain("Failure details");
        if (closeMain) yield* Ref.set(mainRef, Option.none());
        yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
        yield* Deferred.await(remembered);
        if (closeMain || !visible) {
          expect(closeCount).toBe(0);
          if (closeMain) {
            yield* Ref.set(mainRef, Option.some(main));
            mainVisible = false;
            appListeners.get("browser-window-created")?.({}, main);
          }
          mainListeners.get("ready-to-show")?.();
          expect(closeCount).toBe(0);
          mainVisible = true;
          const show = mainListeners.get("show");
          expect(show).toBeDefined();
          show!();
        }
        yield* Effect.promise(() => closed.promise);
        expect(closeCount).toBe(1);
      }
    }),
  ).pipe(Effect.provide(DesktopState.layer)),
);
