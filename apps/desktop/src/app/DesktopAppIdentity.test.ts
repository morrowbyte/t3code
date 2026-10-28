import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>;
};

interface ElectronAppCalls {
  readonly setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions>;
  readonly setDockIcon: string[];
  readonly setName: string[];
  readonly setAppUserModelId?: string[];
}

const layerElectronApp = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: (name) =>
      Effect.sync(() => {
        calls.setName.push(name);
      }),
    setAboutPanelOptions: (options) =>
      Effect.sync(() => {
        calls.setAboutPanelOptions.push(options);
      }),
    setAppUserModelId: (id) =>
      Effect.sync(() => {
        calls.setAppUserModelId?.push(id);
      }),
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: (iconPath) =>
      Effect.sync(() => {
        calls.setDockIcon.push(iconPath);
      }),
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

const layerAssets = (png: Option.Option<string>) =>
  Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.none(),
      icns: Option.none(),
      png,
    }),
    resolveResourcePath: () => Effect.succeedNone,
  } satisfies DesktopAssets.DesktopAssets["Service"]);

const layerEnvironment = (overrides: TestEnvironmentInput = {}) => {
  const { env, ...environmentOverrides } = overrides;
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodePath.layerPosix,
        DesktopConfig.layerTest({
          ...env,
        }),
      ),
    ),
  );
};

const withIdentity = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppIdentity.DesktopAppIdentity
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
  input: {
    readonly calls?: ElectronAppCalls;
    readonly environment?: TestEnvironmentInput;
    readonly legacyPathExists?: boolean;
    readonly legacyPathProbeError?: PlatformError.PlatformError;
    readonly packageJson?: string;
    readonly pngIconPath?: Option.Option<string>;
  } = {},
) => {
  const calls: ElectronAppCalls = input.calls ?? {
    setAboutPanelOptions: [],
    setDockIcon: [],
    setName: [],
  };

  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provide(NodePath.layerPosix),
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: (path) =>
              input.legacyPathProbeError
                ? Effect.fail(input.legacyPathProbeError)
                : Effect.succeed(
                    input.legacyPathExists === true && /T3 Code \((Alpha|Dev)\)/.test(path),
                  ),
            readFileString: () =>
              Effect.succeed(input.packageJson ?? '{"t3codeCommitHash":"abcdef1234567890"}'),
          }),
        ),
        Layer.provideMerge(layerAssets(input.pngIconPath ?? Option.none())),
        Layer.provideMerge(layerElectronApp(calls)),
        Layer.provideMerge(layerEnvironment(input.environment)),
      ),
    ),
  );
};

describe("DesktopAppIdentity", () => {
  it.effect("isolates the V2 profile even when the legacy V1 profile exists", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;

        assert.equal(userDataPath, "/Users/alice/Library/Application Support/t3code-v2");
      }),
      { legacyPathExists: true },
    ),
  );

  it.effect("uses a separate packaged user data profile without inspecting upstream data", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        assert.equal(
          yield* identity.resolveUserDataPath,
          "/Users/alice/Library/Application Support/t3code-morrowbyte",
        );
      }),
      { environment: { env: { T3CODE_DESKTOP_PROFILE: "morrowbyte" } }, legacyPathExists: true },
    ),
  );

  it.effect("shows Crew while preserving existing Morrowbyte app and user-data identities", () => {
    const calls: ElectronAppCalls = { setAboutPanelOptions: [], setDockIcon: [], setName: [] };
    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;
        assert.deepEqual(calls.setName, ["Morrowbyte"]);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "Crew");
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        assert.equal(environment.appUserModelId, "com.morrowbyte.t3code");
        assert.equal(environment.baseDir, "/Users/alice/.t3-morrowbyte");
        assert.equal(
          yield* identity.resolveUserDataPath,
          "/Users/alice/Library/Application Support/t3code-morrowbyte",
        );
      }),
      { calls, environment: { env: { T3CODE_DESKTOP_PROFILE: "morrowbyte" } } },
    );
  });

  it.effect(
    "keeps Windows profile, safeStorage identity and AppUserModelID after renaming to Crew",
    () => {
      const calls: ElectronAppCalls = {
        setAboutPanelOptions: [],
        setDockIcon: [],
        setName: [],
        setAppUserModelId: [],
      };
      return withIdentity(
        Effect.gen(function* () {
          const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
          yield* identity.configure;
          assert.deepEqual(calls.setName, ["Morrowbyte"]);
          assert.deepEqual(calls.setAppUserModelId, ["com.morrowbyte.t3code"]);
          assert.equal(
            yield* identity.resolveUserDataPath,
            "/Users/alice/AppData/Roaming/t3code-morrowbyte",
          );
          assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "Crew");
          assert.include(calls.setAboutPanelOptions[0]?.copyright ?? "", "T3 Code");
        }),
        {
          calls,
          environment: { platform: "win32", env: { T3CODE_DESKTOP_PROFILE: "morrowbyte" } },
        },
      );
    },
  );

  it.effect("keeps using the legacy development profile", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        assert.equal(
          yield* identity.resolveUserDataPath,
          "/Users/alice/Library/Application Support/T3 Code (Dev)",
        );
      }),
      {
        legacyPathExists: true,
        environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
      },
    ),
  );

  it.effect.each([
    { stage: "Beta", environment: {} },
    {
      stage: "Nightly",
      environment: { appVersion: "0.0.43-nightly.20260929.2428" },
    },
    {
      stage: "Dev",
      environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
    },
  ])("uses a valid native User-Agent product name for $stage", ({ stage, environment }) => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        const runtimeName = calls.setName[0];
        assert.isDefined(runtimeName);
        assert.equal(runtimeName, `T3 Code ${stage}`);
        assert.match(runtimeName.replaceAll(" ", ""), /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, `Crew (${stage})`);
      }),
      { calls, environment },
    );
  });
});
