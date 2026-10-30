import { parse as parseYaml, stringify as yaml } from "yaml";
import {
  BoatAction,
  BoatDefaults,
  DEFAULT_BOAT_DEFAULTS,
  BoatError,
  BoatInstance,
  BoatProjectConfig,
  BoatState,
  DEFAULT_BOAT_PROJECT,
  type ProjectId,
  type ThreadId,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Projects from "../project/ProjectService.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { BoatApi } from "./BoatApi.ts";

const ANDROID_SETUP = `export ANDROID_HOME=/home/user/android JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  sudo apt-get update
  sudo apt-get install -y openjdk-21-jdk-headless unzip
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  curl -fsSLo /tmp/crew-android-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q /tmp/crew-android-tools.zip -d "$ANDROID_HOME/cmdline-tools"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm /tmp/crew-android-tools.zip
fi
yes | sdkmanager --licenses >/dev/null
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "emulator" "system-images;android-36;google_apis;x86_64"
if [ ! -d /home/user/.android/avd/crew.avd ]; then
  echo no | avdmanager create avd -n crew -k "system-images;android-36;google_apis;x86_64" -d pixel_6
fi
test -e /dev/kvm
if ! adb devices | grep -q 'emulator-.*device'; then
  DISPLAY=:0 emulator -avd crew -no-audio -gpu swiftshader_indirect >/tmp/crew-emulator.log 2>&1 &
  adb wait-for-device
fi
for attempt in $(seq 1 120); do
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then break; fi
  sleep 2
done
test "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1
adb reverse tcp:8081 tcp:8081
`;
const ANDROID_CREW_DEV = `T3CODE_PORT_OFFSET=0 vp run dev --no-seed >/tmp/crew-backend.log 2>&1 &
crew_backend_pid=$!
crew_metro_pid=""
trap 'kill "$crew_backend_pid" "$crew_metro_pid" 2>/dev/null || true' EXIT
vp run mobile:install android >/tmp/crew-native-install.json
cd apps/mobile
APP_VARIANT=development vp exec expo start --dev-client --scheme morrowbyte-dev --localhost --port 8081 >/tmp/crew-metro.log 2>&1 &
crew_metro_pid=$!
for attempt in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8081/status >/dev/null; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:8081/status >/dev/null
adb shell am start -a android.intent.action.VIEW -d 'morrowbyte-dev://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081&disableAutoLaunch=1&disableFab=1' com.morrowbyte.t3code.dev
cd ../..
T3CODE_PORT=13773 node apps/server/src/bin.ts auth pairing create --base-dir .t3 --base-url http://10.0.2.2:13773 --ttl 15m --label crew-cloud-android >/tmp/crew-android-pairing
crew_pair_link=$(node --input-type=module -e 'import fs from "node:fs"; const output=fs.readFileSync("/tmp/crew-android-pairing","utf8"); const url=output.split("\\n").find(line=>line.startsWith("Pair URL: "))?.slice(10).trim(); if(!url) process.exit(1); process.stdout.write("morrowbyte-dev://connections/new?"+new URLSearchParams({pairingUrl:url,autoConnect:"1"}));')
adb shell am start -a android.intent.action.VIEW -d "$crew_pair_link" com.morrowbyte.t3code.dev
rm /tmp/crew-android-pairing
wait "$crew_metro_pid"`;
export const sourceSyncScript = `python3 - "$1" "$2" "$3" <<'PYTHON'
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

archive = Path(sys.argv[1])
root = Path(sys.argv[2])
manifest = Path(sys.argv[3])
root.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive) as source:
    current = {entry.name.removeprefix("./") for entry in source.getmembers() if not entry.isdir()}
if manifest.exists():
    previous = set(json.loads(manifest.read_text()))
elif any(root.iterdir()):
    index = tempfile.mkdtemp(prefix="crew-source-index-")
    try:
        git = ["git", "--git-dir=" + index, "--work-tree=" + str(root)]
        subprocess.run(git + ["init", "--quiet"], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(git + ["add", "-A", "--", ".", ":(exclude).repos"], cwd=root, check=True)
        previous = set(subprocess.check_output(git + ["ls-files", "-z"], cwd=root).decode().split(chr(0))) - {""}
    finally:
        shutil.rmtree(index)
else:
    previous = set()
for name in previous - current:
    target = root / name
    if target.is_file() or target.is_symlink():
        target.unlink()
subprocess.run(["tar", "-xzf", str(archive), "-C", str(root)], check=True)
manifest.write_text(json.dumps(sorted(current)))
archive.unlink()
print("Crew source synchronized:", len(current), "files;", len(previous - current), "removed")
PYTHON`;
const KEY = "boat-api-key";
const rates = { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 };
const Ledger = Schema.Struct({
  defaults: BoatDefaults.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_BOAT_DEFAULTS))),
  period: Schema.String,
  projects: Schema.Record(Schema.String, BoatProjectConfig),
  instances: Schema.Array(BoatInstance),
});
const encodeLedger = Schema.encodeEffect(Schema.fromJsonString(Ledger));
const ProjectManifest = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
  packageManager: Schema.optional(Schema.String),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeWorkspaceVersions = Schema.decodeUnknownEffect(
  Schema.Struct({ catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
);
const decodeProjectManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectManifest));
const RemoteSandbox = Schema.Struct({
  sandbox: Schema.Struct({ id: Schema.String, state: Schema.String }),
});
const Limits = Schema.Struct({
  canStart: Schema.Boolean,
  startBlockedReason: Schema.NullOr(Schema.String),
  billingStatus: Schema.String,
  maxActiveSandboxes: Schema.Number,
  planIncluded: Schema.Struct({ vmHoursRemaining: Schema.Number }),
  wallet: Schema.Struct({ balanceDollars: Schema.Number }),
  trialComputeCapSeconds: Schema.NullOr(Schema.Number),
  trialComputeUsedSeconds: Schema.NullOr(Schema.Number),
  machineTypes: Schema.Array(Schema.Struct({ type: Schema.String, available: Schema.Boolean })),
});
const Usage = Schema.Struct({ dollars: Schema.Number });
const Deletion = Schema.Struct({
  operation: Schema.Struct({ id: Schema.String, status: Schema.String }),
});
const Process = Schema.Struct({ processId: Schema.Number });
const ProcessStatus = Schema.Struct({
  exitCode: Schema.optional(Schema.Number),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});
const Desktop = Schema.Struct({ desktopUrl: Schema.NullOr(Schema.String) });
const Hosted = Schema.Struct({ url: Schema.String });
const inactive = new Set(["archived", "stopped", "deleted", "error"]);
const storageError = () => new BoatError({ category: "storage" });
const decode =
  <S extends Schema.Top>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(() => new BoatError({ category: "provider" })),
    );

export class BoatService extends Context.Service<
  BoatService,
  {
    readonly reconcile: () => Effect.Effect<void, BoatError>;
    readonly configureDefaults: (defaults: BoatDefaults) => Effect.Effect<BoatState, BoatError>;
    readonly read: (projectId?: ProjectId) => Effect.Effect<BoatState, BoatError>;
    readonly connect: (apiKey: Redacted.Redacted<string>) => Effect.Effect<BoatState, BoatError>;
    readonly disconnect: Effect.Effect<void, BoatError>;
    readonly configure: (
      projectId: ProjectId,
      config: BoatProjectConfig,
    ) => Effect.Effect<BoatState, BoatError>;
    readonly operate: (
      action: BoatAction,
      threadId?: ThreadId,
    ) => Effect.Effect<BoatState, BoatError>;
  }
>()("t3/boat/BoatService") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* Secrets.ServerSecretStore;
  const projects = yield* Projects.ProjectService;
  const git = yield* Git.GitVcsDriver;
  const api = yield* BoatApi;
  const crypto = yield* Crypto.Crypto;
  const previews = yield* PreviewManager;
  const projections = yield* ProjectionStoreV2;
  const lock = yield* Semaphore.make(1);
  const filename = path.join(config.stateDir, "boat.json");
  const initialPeriod = DateTime.formatIso(yield* DateTime.now).slice(0, 7);
  let ledger: typeof Ledger.Type = yield* fs.exists(filename).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs
            .readFileString(filename)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Ledger))))
        : Effect.succeed({
            period: initialPeriod,
            defaults: DEFAULT_BOAT_DEFAULTS,
            projects: {},
            instances: [],
          }),
    ),
    Effect.mapError(storageError),
  );
  const save = Effect.fn("BoatService.save")(function* (next: typeof Ledger.Type) {
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    const json = yield* encodeLedger(next);
    const temp = `${filename}.tmp`;
    yield* fs.writeFileString(temp, json, { mode: 0o600 });
    yield* fs.rename(temp, filename);
    ledger = next;
  }, Effect.mapError(storageError));
  const updateInstance = Effect.fn("BoatService.updateInstance")(
    (
      requestId: string,
      update: Partial<BoatInstance> | ((item: BoatInstance) => Partial<BoatInstance>),
    ) =>
      lock.withPermits(1)(
        Effect.suspend(() =>
          save({
            ...ledger,
            instances: ledger.instances.map((item) =>
              item.requestId === requestId
                ? { ...item, ...(typeof update === "function" ? update(item) : update) }
                : item,
            ),
          }),
        ),
      ),
  );
  const key = Effect.gen(function* () {
    const value = yield* secrets.get(KEY).pipe(Effect.mapError(storageError));
    if (Option.isNone(value)) return yield* new BoatError({ category: "not_configured" });
    return Redacted.make(new TextDecoder().decode(value.value));
  });
  const project = Effect.fn("BoatService.project")(function* (projectId: ProjectId) {
    const found = yield* projects
      .getShell(projectId)
      .pipe(Effect.mapError(() => new BoatError({ category: "not_found" })));
    if (Option.isNone(found)) return yield* new BoatError({ category: "not_found" });
    return found.value;
  });
  const projectSettings = (projectId: ProjectId) => {
    const value = ledger.projects[projectId] ?? DEFAULT_BOAT_PROJECT;
    return value.inheritDefaults ? { ...value, ...ledger.defaults } : value;
  };
  const previewLock = yield* Semaphore.make(1);
  const attachPreview = Effect.fn("BoatService.attachPreview")(
    (item: BoatInstance, token: Redacted.Redacted<string>, reveal = false) =>
      previewLock.withPermits(1)(
        Effect.gen(function* () {
          const current =
            ledger.instances.find((candidate) => candidate.requestId === item.requestId) ?? item;
          if (!current.sandboxId) return current;
          const settings = projectSettings(current.projectId);
          let previewUrl = current.previewUrl;
          if (!previewUrl || (reveal && settings.previewKind === "web")) {
            const sandboxPath = `/sandboxes/${encodeURIComponent(current.sandboxId)}`;
            if (settings.previewKind === "android") {
              const desktop = yield* api
                .request(token, `${sandboxPath}/desktop?vnc=1`, "POST")
                .pipe(Effect.flatMap(decode(Desktop)));
              if (!desktop.desktopUrl) return current;
              previewUrl = desktop.desktopUrl;
            } else {
              const hosted = yield* api
                .request(token, `${sandboxPath}/host`, "POST", {
                  port: settings.port,
                  public: false,
                })
                .pipe(Effect.flatMap(decode(Hosted)));
              const credential = yield* secrets
                .get(`boat-dev-${current.requestId}`)
                .pipe(Effect.mapError(storageError));
              const url = new URL(hosted.url);
              if (Option.isSome(credential)) {
                url.pathname = "/pair";
                url.hash = `token=${Buffer.from(credential.value).toString("hex")}`;
              }
              previewUrl = url.toString();
            }
          }
          let previewTabId = current.previewTabId;
          if (current.threadId) {
            const listed = yield* previews.list({ threadId: current.threadId });
            const existing = listed.sessions.find((session) => session.tabId === previewTabId);
            if (!existing) {
              const opened = yield* previews
                .open({
                  threadId: current.threadId,
                  url: previewUrl,
                  runtime: "server",
                  reveal: true,
                })
                .pipe(Effect.mapError(() => new BoatError({ category: "provider" })));
              previewTabId = opened.tabId;
            } else if (reveal)
              yield* previews
                .requestReveal({ threadId: current.threadId, tabId: existing.tabId, force: true })
                .pipe(Effect.mapError(() => new BoatError({ category: "provider" })));
          }
          const next = { ...current, previewUrl, previewTabId };
          yield* updateInstance(current.requestId, next);
          return next;
        }),
      ),
  );
  const read = Effect.fn("BoatService.read")(function* (projectId?: ProjectId) {
    if (projectId) yield* project(projectId);
    const period = DateTime.formatIso(yield* DateTime.now).slice(0, 7);
    if (ledger.period !== period)
      yield* lock.withPermits(1)(
        Effect.suspend(() =>
          save({
            ...ledger,
            period,
            instances: ledger.instances.map((item) => ({ ...item, costUsd: 0 })),
          }),
        ),
      );

    const stored = yield* secrets.get(KEY).pipe(Effect.mapError(storageError));
    if (Option.isNone(stored))
      return {
        defaults: ledger.defaults,
        configured: false,
        account: null,
        projects: ledger.projects,
        instances: ledger.instances.filter((item) => !projectId || item.projectId === projectId),
      };
    const token = Redacted.make(new TextDecoder().decode(stored.value));
    const limits = yield* api.request(token, "/limits").pipe(Effect.flatMap(decode(Limits)));
    const instances = yield* Effect.forEach(
      ledger.instances.filter((item) => !projectId || item.projectId === projectId),
      (item) =>
        Effect.gen(function* () {
          if (!item.sandboxId || item.state === "deleted") return item;
          if (item.deletionOperationId) {
            const result = yield* api
              .request(
                token,
                `/deletion-operations/${encodeURIComponent(item.deletionOperationId)}`,
              )
              .pipe(Effect.flatMap(decode(Deletion)));
            const next = {
              ...item,
              state: result.operation.status === "completed" ? "deleted" : "deleting",
            };
            yield* updateInstance(item.requestId, next);
            return next;
          }
          const remote = yield* api
            .request(token, `/sandboxes/${encodeURIComponent(item.sandboxId)}`)
            .pipe(
              Effect.flatMap(decode(RemoteSandbox)),
              Effect.catchTags({
                BoatError: (error) =>
                  error.status === 404
                    ? Effect.succeed({ sandbox: { id: item.sandboxId!, state: "deleted" } })
                    : Effect.fail(error),
              }),
            );
          if (remote.sandbox.state === "deleted") {
            const next = { ...item, state: "deleted", processId: null, previewUrl: null };
            yield* updateInstance(item.requestId, next);
            return next;
          }
          const usage = yield* api
            .request(
              token,
              `/sandboxes/${encodeURIComponent(item.sandboxId)}/usage?since=${encodeURIComponent(`${period}-01T00:00:00Z`)}`,
            )
            .pipe(Effect.flatMap(decode(Usage)));
          const stopped = ["archived", "stopped"].includes(remote.sandbox.state);
          const next = {
            ...item,
            state: remote.sandbox.state,
            costUsd: usage.dollars,
            stoppedAt: stopped ? (item.stoppedAt ?? DateTime.formatIso(yield* DateTime.now)) : null,
          };
          yield* updateInstance(item.requestId, next);
          if (next.threadId && next.processId !== null && !inactive.has(next.state)) {
            if (next.previewUrl) return yield* attachPreview(next, token);
            const settings = projectSettings(item.projectId);
            const probe = yield* api
              .request(token, `/sandboxes/${encodeURIComponent(item.sandboxId)}/commands`, "POST", {
                command:
                  settings.previewKind === "android"
                    ? "/home/user/android/platform-tools/adb shell getprop sys.boot_completed | grep -q '^1'"
                    : `curl -fsS --max-time 2 http://127.0.0.1:${settings.port}/ -o /dev/null`,
                timeoutSeconds: 3,
              })
              .pipe(Effect.orElseSucceed(() => null));
            if (probe && typeof probe === "object" && "exitCode" in probe && probe.exitCode === 0)
              return yield* attachPreview(next, token);
          }
          return next;
        }),
      { concurrency: 4 },
    );
    return {
      defaults: ledger.defaults,
      configured: true,
      account: {
        status: limits.billingStatus,
        canStart: limits.canStart,
        reason: limits.startBlockedReason,
        remainingHours:
          limits.billingStatus === "trialing"
            ? Math.max(
                0,
                (limits.trialComputeCapSeconds ?? 0) - (limits.trialComputeUsedSeconds ?? 0),
              ) / 3600
            : limits.planIncluded.vmHoursRemaining,
        walletUsd: limits.wallet.balanceDollars,
        maxConcurrent: limits.maxActiveSandboxes,
        sizes: limits.machineTypes
          .filter((item) => item.available)
          .map((item) => item.type)
          .filter((item): item is typeof BoatProjectConfig.Type.size => item in rates),
      },
      projects: ledger.projects,
      instances,
    };
  });
  const connect = Effect.fn("BoatService.connect")(function* (apiKey: Redacted.Redacted<string>) {
    if (!Redacted.value(apiKey).startsWith("boat_"))
      return yield* new BoatError({ category: "invalid_key" });
    yield* api.request(apiKey, "/limits").pipe(Effect.flatMap(decode(Limits)));
    yield* secrets
      .set(KEY, new TextEncoder().encode(Redacted.value(apiKey)))
      .pipe(Effect.mapError(storageError));
    return yield* read();
  });
  const disconnect = Effect.gen(function* () {
    if (ledger.instances.some((item) => !inactive.has(item.state)))
      return yield* new BoatError({ category: "conflict" });
    yield* secrets.remove(KEY).pipe(Effect.mapError(storageError));
  });
  const configure = Effect.fn("BoatService.configure")(function* (
    projectId: ProjectId,
    settings: BoatProjectConfig,
  ) {
    const source = yield* project(projectId);
    if (
      settings.enabled &&
      (!settings.devCommand.trim() ||
        settings.devCommand === "T3CODE_PORT_OFFSET=0 vp run dev --no-seed" ||
        settings.devCommand === ANDROID_CREW_DEV)
    ) {
      const manifestPath = path.join(source.workspaceRoot, "package.json");
      const manifest = yield* fs.readFileString(manifestPath).pipe(
        Effect.flatMap(decodeProjectManifest),
        Effect.orElseSucceed(() => null),
      );
      if (manifest?.scripts.dev) {
        let viteVersion = manifest.devDependencies?.["vite-plus"];
        if (viteVersion?.startsWith("catalog:")) {
          const workspace = yield* fs
            .readFileString(path.join(source.workspaceRoot, "pnpm-workspace.yaml"))
            .pipe(
              Effect.flatMap((text) => Effect.try(() => parseYaml(text))),
              Effect.flatMap(decodeWorkspaceVersions),
              Effect.orElseSucceed(() => null),
            );
          viteVersion = workspace?.catalog?.["vite-plus"];
        }
        const manager = manifest.packageManager?.split("@")[0] ?? "npm";
        const command = viteVersion ? "vp" : manager;
        const install = viteVersion
          ? `npm install --prefix $HOME/.crew-tools --no-save vite-plus@${viteVersion}\nexport PATH="$HOME/.crew-tools/node_modules/.bin:$PATH"\nif [ -n "\${GITHUB_PATH:-}" ]; then echo "$HOME/.crew-tools/node_modules/.bin" >> "$GITHUB_PATH"; fi\nvp install --frozen-lockfile`
          : manager === "npm"
            ? "npm ci"
            : `corepack ${manager} install --frozen-lockfile`;
        const crew = manifest.scripts.dev.includes("scripts/dev-runner.ts");
        settings = {
          ...settings,
          setupCommand: settings.setupCommand.trim() || install,
          devCommand: crew
            ? settings.previewKind === "android"
              ? ANDROID_CREW_DEV
              : "T3CODE_PORT_OFFSET=0 vp run dev --no-seed"
            : settings.previewKind === "android" && manifest.dependencies?.expo
              ? "npx expo run:android --no-bundler && npx expo start --dev-client --localhost --port 8081"
              : `${command} run dev`,
          port: crew ? 5733 : settings.port,
          ciCommand:
            settings.ciCommand === DEFAULT_BOAT_PROJECT.ciCommand
              ? `${command} run ${manifest.scripts["check:integration"] ? "check:integration" : "test"}`
              : settings.ciCommand,
        };
      }
    }
    const workflow = path.join(source.workspaceRoot, ".github", "workflows", "crew-boat.yml");
    const marker = "# Managed by Crew Boat integration.\n";
    const exists = yield* fs.exists(workflow).pipe(Effect.mapError(storageError));
    if (exists) {
      const current = yield* fs.readFileString(workflow).pipe(Effect.mapError(storageError));
      if (!current.startsWith(marker)) return yield* new BoatError({ category: "conflict" });
    }
    if (settings.ciEnabled) {
      if (!settings.ciCommand.trim()) return yield* new BoatError({ category: "disabled" });
      const setup = settings.setupCommand.trim()
        ? [{ name: "Setup project", run: settings.setupCommand }]
        : [];
      const runner =
        `boat-${settings.size === "default" ? "" : settings.size}`.replace(/-$/, "") +
        (settings.snapshot ? `/from=${settings.snapshot}` : "");
      const jobs: Record<string, unknown> = {
        check: {
          "runs-on": runner,
          "timeout-minutes": 30,
          steps: [
            { uses: "actions/checkout@v4" },
            ...setup,
            { name: "Check", run: settings.ciCommand },
          ],
        },
      };
      if (settings.releaseCommand.trim())
        jobs.release = {
          if: "github.event_name == 'workflow_dispatch' && inputs.release",
          needs: ["check"],
          "runs-on": runner,
          "timeout-minutes": 60,
          permissions: { contents: "write" },
          steps: [
            { uses: "actions/checkout@v4" },
            ...setup,
            {
              name: "Release",
              run: settings.releaseCommand,
              env: { GH_TOKEN: "${{ github.token }}" },
            },
          ],
        };
      const content =
        marker +
        yaml({
          name: "Crew Boat",
          on: {
            push: { branches: ["main"] },
            pull_request: {},
            workflow_dispatch: {
              inputs: {
                release: {
                  description: "Run the configured release command",
                  type: "boolean",
                  default: false,
                },
              },
            },
          },
          permissions: { contents: "read" },
          concurrency: {
            group: "crew-boat-${{ github.ref }}",
            "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
          },
          jobs,
        });
      yield* fs
        .makeDirectory(path.dirname(workflow), { recursive: true })
        .pipe(Effect.mapError(storageError));
      yield* fs.writeFileString(workflow, content).pipe(Effect.mapError(storageError));
    } else if (exists) {
      yield* fs.remove(workflow).pipe(Effect.mapError(storageError));
    }
    yield* lock.withPermits(1)(
      Effect.suspend(() =>
        save({ ...ledger, projects: { ...ledger.projects, [projectId]: settings } }),
      ),
    );
    return yield* read(projectId);
  });
  const configureDefaults = Effect.fn("BoatService.configureDefaults")(function* (
    defaults: BoatDefaults,
  ) {
    yield* lock.withPermits(1)(Effect.suspend(() => save({ ...ledger, defaults })));
    return yield* read();
  });
  const operate = Effect.fn("BoatService.operate")(function* (
    action: BoatAction,
    threadId?: ThreadId,
  ) {
    // Owned machines still need cleanup after their project has been removed.
    if (action.action !== "stop" && action.action !== "delete") yield* project(action.projectId);
    const agentThreadId = threadId;
    threadId ??= action.threadId;
    if (threadId) {
      const thread = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.mapError(storageError));
      if (!thread || thread.projectId !== action.projectId)
        return yield* new BoatError({ category: "not_found" });
    }
    const token = yield* key;
    const settings = projectSettings(action.projectId);
    if (
      ledger.instances.some(
        (item) => item.requestId === action.requestId && item.projectId !== action.projectId,
      )
    )
      return yield* new BoatError({ category: "conflict" });
    let instance = ledger.instances.find(
      (item) => item.requestId === action.requestId && item.projectId === action.projectId,
    );
    if (action.action === "start") {
      if (instance?.sandboxId) return yield* read(action.projectId);
      if (!settings.enabled) return yield* new BoatError({ category: "disabled" });
      const status = yield* read(action.projectId);
      if (!status.account?.canStart || !status.account.sizes.includes(settings.size))
        return yield* new BoatError({ category: "capacity" });
      const reservation = (settings.ttlMinutes / 60) * rates[settings.size];
      const now = yield* Clock.currentTimeMillis;
      instance ??= {
        requestId: action.requestId,
        projectId: action.projectId,
        sandboxId: null,
        size: settings.size,
        state: "provisioning",
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + settings.ttlMinutes * 60000)),
        costUsd: 0,
        threadId: threadId ?? null,
        previewTabId: null,
        leases: agentThreadId ? [agentThreadId] : [],
        stoppedAt: null,
        processId: null,
        deletionOperationId: null,
        output: "",
        snapshot: settings.snapshot,
        previewUrl: null,
      };
      const reserved = instance;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (
            ledger.instances.some(
              (item) => item.requestId === action.requestId && item.projectId === action.projectId,
            )
          )
            return;
          const own = ledger.instances.filter((item) => item.projectId === action.projectId);
          if (own.filter((item) => !inactive.has(item.state)).length >= settings.maxConcurrent)
            return yield* new BoatError({ category: "capacity" });
          if (
            own.reduce(
              (sum, item) =>
                sum +
                item.costUsd +
                (inactive.has(item.state)
                  ? 0
                  : (Math.max(0, Date.parse(item.expiresAt) - now) / 3600000) * rates[item.size]),
              0,
            ) +
              reservation >
            settings.budgetUsd
          )
            return yield* new BoatError({ category: "budget" });
          yield* save({ ...ledger, instances: [...ledger.instances, reserved] });
        }),
      );
      if (now - Date.parse(instance.createdAt) > 23 * 3600000)
        return yield* new BoatError({ category: "conflict" });
      const created = yield* api
        .request(
          token,
          "/sandboxes",
          "POST",
          {
            type: instance.size,
            ttlSeconds: Math.round(
              (Date.parse(instance.expiresAt) - Date.parse(instance.createdAt)) / 1000,
            ),
            noEnv: true,
            name: `Crew ${action.projectId}`.slice(0, 120),
            labels: { "crew.project": action.projectId, "crew.request": action.requestId },
            ...(instance.snapshot ? { from: instance.snapshot } : {}),
          },
          action.requestId,
        )
        .pipe(
          Effect.flatMap(decode(RemoteSandbox)),
          Effect.catchTags({
            BoatError: Effect.fn("BoatService.createFailed")(function* (error) {
              if (
                error.status !== undefined &&
                error.status >= 400 &&
                error.status < 500 &&
                error.status !== 409
              )
                yield* updateInstance(action.requestId, { state: "error" });
              return yield* error;
            }),
          }),
        );
      yield* updateInstance(action.requestId, {
        sandboxId: created.sandbox.id,
        state: created.sandbox.state,
      });
      return yield* read(action.projectId);
    }
    if (!instance?.sandboxId) return yield* new BoatError({ category: "not_found" });
    const sandboxPath = `/sandboxes/${encodeURIComponent(instance.sandboxId)}`;
    if (
      agentThreadId &&
      ["prepare", "exec", "resume", "renew"].includes(action.action) &&
      !instance.leases.includes(agentThreadId)
    ) {
      yield* updateInstance(action.requestId, (current) => ({
        leases: Array.from(new Set([...current.leases, agentThreadId])),
      }));
    }
    if (action.action === "renew") {
      const now = yield* Clock.currentTimeMillis;
      const spent = ledger.instances
        .filter((item) => item.projectId === action.projectId)
        .reduce(
          (sum, item) =>
            sum +
            item.costUsd +
            (item.requestId !== instance!.requestId && !inactive.has(item.state)
              ? (Math.max(0, Date.parse(item.expiresAt) - now) / 3600000) * rates[item.size]
              : 0),
          0,
        );
      if (spent + (settings.ttlMinutes / 60) * rates[instance.size] > settings.budgetUsd)
        return yield* new BoatError({ category: "budget" });
      yield* api.request(token, sandboxPath, "PATCH", { ttlSeconds: settings.ttlMinutes * 60 });
      yield* updateInstance(action.requestId, {
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + settings.ttlMinutes * 60000)),
      });
      return yield* read(action.projectId);
    }
    if (action.action === "delete") {
      const usage = yield* api
        .request(
          token,
          `${sandboxPath}/usage?since=${encodeURIComponent(`${ledger.period}-01T00:00:00Z`)}`,
        )
        .pipe(Effect.flatMap(decode(Usage)));
      const result = yield* api
        .request(token, sandboxPath, "DELETE")
        .pipe(Effect.flatMap(decode(Deletion)));
      yield* updateInstance(action.requestId, {
        state: "deleting",
        costUsd: usage.dollars,
        deletionOperationId: result.operation.id,
        previewUrl: null,
      });
    } else if (action.action === "prepare") {
      const source = yield* project(action.projectId);
      const process =
        instance.processId === null
          ? null
          : yield* api
              .request(token, `${sandboxPath}/commands`, "POST", {
                command: `kill -0 ${instance.processId} 2>/dev/null`,
                timeoutSeconds: 3,
              })
              .pipe(Effect.orElseSucceed(() => null));
      const running =
        process !== null &&
        typeof process === "object" &&
        "exitCode" in process &&
        process.exitCode === 0;
      if (threadId) yield* updateInstance(action.requestId, { threadId });
      if (!settings.enabled || !settings.devCommand.trim())
        return yield* new BoatError({ category: "disabled" });
      if (settings.previewKind === "android")
        yield* api.request(token, `${sandboxPath}/desktop?vnc=1`, "POST");
      const archive = yield* fs
        .makeTempFile({ prefix: "crew-boat-", suffix: ".tar.gz" })
        .pipe(Effect.mapError(storageError));
      yield* Effect.gen(function* () {
        const indexPath = `${archive}.index`;
        const env = { GIT_INDEX_FILE: indexPath };
        const execute = (args: ReadonlyArray<string>) =>
          git
            .execute({ operation: "boat-archive", cwd: source.workspaceRoot, args, env })
            .pipe(Effect.mapError(() => new BoatError({ category: "storage" })));
        yield* Effect.gen(function* () {
          yield* execute(["read-tree", "HEAD"]);
          yield* execute(["add", "-A", "--", ".", ":(exclude).repos"]);
          const tree = yield* execute(["write-tree"]);
          yield* execute([
            "archive",
            "--format=tar.gz",
            "--output",
            archive,
            tree.stdout.trim(),
            "--",
            ".",
            ":(exclude).repos",
          ]);
        }).pipe(Effect.ensuring(fs.remove(indexPath).pipe(Effect.orElseSucceed(() => undefined))));
        const bytes = yield* fs.readFile(archive).pipe(Effect.mapError(storageError));
        if (bytes.byteLength > 256 * 1024 * 1024)
          return yield* new BoatError({ category: "capacity" });
        const remoteArchive = `/home/user/${path.basename(archive)}`;
        const chunkSize = 4 * 1024 * 1024;
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          const name = `${path.basename(archive)}.part-${chunks.length}`;
          yield* api.request(token, `${sandboxPath}/files`, "PUT", {
            path: name,
            content: Buffer.from(bytes.subarray(offset, offset + chunkSize)).toString("base64"),
            encoding: "base64",
          });
          chunks.push(`/home/user/${name}`);
        }
        let devAuth = "";
        if (
          settings.devCommand.includes("scripts/dev-runner") ||
          settings.devCommand.includes("vp run dev --no-seed")
        ) {
          const secretName = `boat-dev-${action.requestId}`;
          const existing = yield* secrets.get(secretName).pipe(Effect.mapError(storageError));
          const bytes = Option.isSome(existing)
            ? existing.value
            : yield* crypto.randomBytes(32).pipe(Effect.mapError(storageError));
          if (Option.isNone(existing))
            yield* secrets.set(secretName, bytes).pipe(Effect.mapError(storageError));
          const credential = Buffer.from(bytes).toString("hex");
          const hosted = yield* api
            .request(token, `${sandboxPath}/host`, "POST", {
              port: settings.port,
              public: false,
            })
            .pipe(Effect.flatMap(decode(Hosted)));
          devAuth = `export T3CODE_DEV_AUTH_TOKEN=${credential}\nexport T3CODE_DEV_ALLOWED_ORIGINS=${new URL(hosted.url).origin}\nexport T3CODE_DEV_ALLOWED_HOSTS=${new URL(hosted.url).hostname}\nexport T3CODE_DEV_WEB_HOST=0.0.0.0\nexport NODE_OPTIONS="--dns-result-order=ipv4first \${NODE_OPTIONS:-}"\n`;
        }
        const androidSetup = settings.previewKind === "android" ? ANDROID_SETUP : "";
        const sync = `set -eu\ncat ${chunks.join(" ")} > ${remoteArchive}\nrm ${chunks.join(" ")}\nset -- ${remoteArchive} /home/user/crew /home/user/.crew-source-files.json\n${sourceSyncScript}`;
        if (running) {
          const result = yield* api
            .request(token, `${sandboxPath}/commands`, "POST", {
              command: sync,
              timeoutSeconds: 20,
            })
            .pipe(Effect.flatMap(decode(ProcessStatus)));
          if (result.exitCode !== undefined && result.exitCode !== 0)
            return yield* new BoatError({ category: "provider" });
          yield* updateInstance(action.requestId, {
            output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-12000),
          });
        } else {
          const script = `${sync}\n${devAuth}${androidSetup}\ncd /home/user/crew\n${settings.setupCommand}\n${settings.devCommand}`;
          const started = yield* api
            .request(token, `${sandboxPath}/commands`, "POST", {
              command: script,
              detached: true,
            })
            .pipe(Effect.flatMap(decode(Process)));
          yield* updateInstance(action.requestId, { processId: started.processId });
        }
      }).pipe(Effect.ensuring(fs.remove(archive).pipe(Effect.orElseSucceed(() => undefined))));
    } else if (action.action === "exec") {
      const output = yield* api
        .request(token, `${sandboxPath}/commands`, "POST", {
          command: action.command,
          cwd: "crew",
          timeoutSeconds: 20,
        })
        .pipe(Effect.flatMap(decode(ProcessStatus)));
      yield* updateInstance(action.requestId, {
        output: `${output.stdout ?? ""}\n${output.stderr ?? ""}`
          .replace(/(#token=)[^\s]+/g, "$1[private]")
          .slice(-12000),
      });
    } else if (action.action === "snapshot") {
      const name = `crew-${action.requestId}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 63);
      yield* api.request(token, "/saved-snapshots", "POST", {
        sandboxId: instance.sandboxId,
        name,
      });
      yield* lock.withPermits(1)(
        Effect.suspend(() =>
          save({
            ...ledger,
            projects: { ...ledger.projects, [action.projectId]: { ...settings, snapshot: name } },
          }),
        ),
      );
    } else if (action.action === "logs") {
      if (instance.processId === null) return yield* new BoatError({ category: "not_found" });
      const output = yield* api
        .request(token, `${sandboxPath}/commands/${instance.processId}`)
        .pipe(Effect.flatMap(decode(ProcessStatus)));
      yield* updateInstance(action.requestId, {
        output: `${output.stdout ?? ""}\n${output.stderr ?? ""}`
          .replace(/(#token=)[^\s]+/g, "$1[private]")
          .slice(-12000),
      });
    } else if (action.action === "cancel") {
      if (instance.processId !== null)
        yield* api.request(token, `${sandboxPath}/commands/${instance.processId}`, "DELETE");
      yield* updateInstance(action.requestId, { processId: null });
    } else if (action.action === "preview") {
      if (threadId) yield* updateInstance(action.requestId, { threadId });
      yield* attachPreview({ ...instance, threadId: threadId ?? instance.threadId }, token, true);
    } else {
      if (action.action === "resume") {
        if (!settings.enabled) return yield* new BoatError({ category: "disabled" });
        const fresh = yield* read(action.projectId);
        if (!fresh.account?.canStart) return yield* new BoatError({ category: "capacity" });
        const own = fresh.instances;
        const others = own.filter(
          (item) => item.requestId !== action.requestId && !inactive.has(item.state),
        );
        if (others.length >= settings.maxConcurrent)
          return yield* new BoatError({ category: "capacity" });
        const now = yield* Clock.currentTimeMillis;
        const reservedCost = others.reduce(
          (sum, item) =>
            sum + (Math.max(0, Date.parse(item.expiresAt) - now) / 3600000) * rates[item.size],
          0,
        );
        if (
          reservedCost +
            own.reduce((sum, item) => sum + item.costUsd, 0) +
            (settings.ttlMinutes / 60) * rates[instance.size] >
          settings.budgetUsd
        )
          return yield* new BoatError({ category: "budget" });
        yield* updateInstance(action.requestId, {
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + settings.ttlMinutes * 60000)),
        });
      }
      yield* api.request(
        token,
        `${sandboxPath}/${action.action}`,
        "POST",
        action.action === "resume" ? { ttlSeconds: settings.ttlMinutes * 60 } : {},
      );
      yield* updateInstance(action.requestId, {
        state: action.action === "stop" ? "stopping" : "provisioning",
        processId: null,
        previewUrl: null,
        leases: action.action === "resume" && agentThreadId ? [agentThreadId] : [],
      });
    }
    if (["stop", "delete"].includes(action.action) && instance.threadId && instance.previewTabId) {
      yield* previews
        .close({ threadId: instance.threadId, tabId: PreviewTabId.make(instance.previewTabId) })
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* updateInstance(action.requestId, { previewTabId: null, processId: null });
    }
    const result = yield* read(
      action.action === "stop" || action.action === "delete" ? undefined : action.projectId,
    );
    return {
      ...result,
      instances: result.instances.filter((item) => item.projectId === action.projectId),
    };
  });
  const reconcile = Effect.fn("BoatService.reconcile")(function* () {
    const owned = ledger.instances.filter(
      (item) => item.sandboxId && item.state !== "deleted" && item.state !== "error",
    );
    if (owned.length === 0) return;
    yield* read();
    const now = yield* Clock.currentTimeMillis;
    for (const item of ledger.instances) {
      if (!item.sandboxId || item.state === "deleted" || item.state === "deleting") continue;
      const settings = projectSettings(item.projectId);
      if (["archived", "stopped"].includes(item.state)) {
        if (item.stoppedAt && now - Date.parse(item.stoppedAt) >= settings.retentionDays * 86400000)
          yield* operate({
            action: "delete",
            projectId: item.projectId,
            requestId: item.requestId,
          });
        continue;
      }
      if (inactive.has(item.state)) continue;
      if (Date.parse(item.expiresAt) <= now) {
        yield* operate({ action: "stop", projectId: item.projectId, requestId: item.requestId });
        continue;
      }
      if (item.leases.length === 0) continue;
      const owners = yield* Effect.forEach(item.leases, (threadId) =>
        projections.getThreadShell(threadId).pipe(Effect.mapError(storageError)),
      );
      const inUse = owners.some(
        (thread) => thread && (thread.activeRunId !== null || thread.activityRunStatus != null),
      );
      if (!inUse)
        yield* operate({ action: "stop", projectId: item.projectId, requestId: item.requestId });
      else if (Date.parse(item.expiresAt) - now < settings.ttlMinutes * 30000)
        yield* operate({ action: "renew", projectId: item.projectId, requestId: item.requestId });
    }
  });
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* reconcile().pipe(Effect.orElseSucceed(() => undefined));
      yield* Effect.sleep("10 seconds");
    }),
  ).pipe(Effect.forkScoped);
  return { read, connect, disconnect, configure, configureDefaults, operate, reconcile };
});

export const layer = Layer.effect(BoatService, make);
