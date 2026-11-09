import { parse as parseYaml, stringify as yaml } from "yaml";
import {
  BoatAction,
  BoatTransferInput,
  BoatTransferProposal,
  type BoatTransferReceipt,
  AuthSessionId,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  type BoatAnalytics,
  type BoatAnalyticsInput,
  type BoatUsagePoint,
  BoatDefaults,
  DEFAULT_BOAT_DEFAULTS,
  BoatError,
  BoatInstance,
  SavedSnapshot,
  BoatProjectConfig,
  BoatState,
  DEFAULT_BOAT_PROJECT,
  DeviceHostUnavailableError,
  type DeviceSession,
  ProjectId,
  ThreadId,
  PreviewTabId,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Projects from "../project/ProjectService.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { BoatApi } from "./BoatApi.ts";
import * as BoatSshTunnel from "./BoatSshTunnel.ts";
import {
  boatLifecycleCounts,
  boatThreadIds,
  boatUsageRunning,
  boatUsageWindows,
  estimateBoatThreadUsage,
  recordBoatLease,
  MAX_ANALYTICS_INSTANCES,
  MAX_USAGE_SAMPLES,
} from "./boatAnalytics.ts";

const ANDROID_SETUP = `if [ -d /home/user/android ] && [ ! -e /home/user/Android/Sdk ] && [ ! -L /home/user/Android/Sdk ]; then
  mkdir -p /home/user/Android
  ln -s /home/user/android /home/user/Android/Sdk
fi
export ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
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
if not (root / ".git").exists():
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    paths = (chr(0).join(sorted(current)) + chr(0)).encode()
    subprocess.run(["git", "-C", str(root), "add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], input=paths, check=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.name=Crew", "-c", "user.email=crew@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initialize cloud workspace"], check=True)
manifest.write_text(json.dumps(sorted(current)))
archive.unlink()
print("Crew source synchronized:", len(current), "files;", len(previous - current), "removed")
PYTHON`;
const KEY = "boat-api-key";
const rates = { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 };
const StoredInstance = Schema.Struct({
  ...BoatInstance.fields,
  usageThreadIds: Schema.Array(ThreadId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  usageHistoryKnownSince: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  usageTimeline: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      threadIds: Schema.Array(ThreadId),
      running: Schema.Boolean,
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  revision: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  sourceBinding: Schema.NullOr(
    Schema.Struct({
      revision: Schema.Number,
      proposal: BoatTransferProposal,
      sessionId: AuthSessionId,
      committedAt: Schema.String,
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  resumeOperation: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      ttlSeconds: Schema.Number,
      previousState: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("archived"))),
      previousExpiresAt: Schema.NullOr(Schema.String).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(null)),
      ),
      previousStoppedAt: Schema.NullOr(Schema.String).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(null)),
      ),
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
type StoredInstance = typeof StoredInstance.Type;
const UsageSample = Schema.Struct({
  sandboxId: Schema.String,
  since: Schema.String,
  until: Schema.String,
  seconds: Schema.Number,
  dollars: Schema.Number,
  recordedAt: Schema.String,
});
const Ledger = Schema.Struct({
  defaults: BoatDefaults.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_BOAT_DEFAULTS))),
  period: Schema.String,
  projects: Schema.Record(Schema.String, BoatProjectConfig),
  instances: Schema.Array(StoredInstance),
  usageSamples: Schema.Array(UsageSample).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
const encodeLedger = Schema.encodeEffect(Schema.fromJsonString(Ledger));
const encodeCacheKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
const SnapshotResponse = Schema.Struct({ snapshot: SavedSnapshot });
const RemoteSandbox = Schema.Struct({
  sandbox: Schema.Struct({
    id: Schema.String,
    state: Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (state) => (state === "provisioned" ? "idle" : state),
          encode: (state) => state,
        }),
      ),
    ),
  }),
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
const AnalyticsUsage = Schema.Struct({
  sandboxId: Schema.String,
  since: Schema.String,
  until: Schema.String,
  seconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  dollars: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  running: Schema.Boolean,
});
const Deletion = Schema.Struct({
  operation: Schema.Struct({ id: Schema.String, status: Schema.String }),
});
const Process = Schema.Struct({ processId: Schema.Number });
const ProcessStatus = Schema.Struct({
  processId: Schema.optional(Schema.Number),
  exitCode: Schema.optional(
    Schema.NullOr(Schema.Number).pipe(
      Schema.decodeTo(
        Schema.UndefinedOr(Schema.Number),
        SchemaTransformation.transform({
          decode: (exitCode) => exitCode ?? undefined,
          encode: (exitCode) => exitCode ?? null,
        }),
      ),
    ),
  ),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});
const Work = Schema.Record(
  Schema.String,
  Schema.Struct({
    source: Schema.Struct({
      projectId: ProjectId,
      threadId: Schema.NullOr(ThreadId),
      workspaceRoot: Schema.String,
    }),
    commands: Schema.Array(
      Schema.Struct({
        processId: Schema.Number,
        threadId: Schema.NullOr(ThreadId),
        expiresAt: Schema.String,
      }),
    ),
    sourceTree: Schema.optionalKey(Schema.String),
    bindingRevision: Schema.optionalKey(Schema.Number),
  }),
);
const encodeWork = Schema.encodeEffect(Schema.fromJsonString(Work));
const decodeTransferInput = Schema.decodeEffect(BoatTransferInput);
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

export interface BoatLeaseAccess {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly sandboxId: string;
  readonly expiresAt: string;
  readonly sourceTree?: string | null;
  readonly check: Effect.Effect<void, BoatError>;
  readonly revoked: Effect.Effect<void>;
}

// Descriptors come from the verified server-side Actor/Viewer inventory, never model arguments.
export interface BoatDesktopDescriptor {
  readonly viewer: { readonly remotePort: number; readonly path: string };
  readonly actor: {
    readonly commandPath: string;
    readonly sha256: string;
    readonly expectedServerName: string;
    readonly protocolRevision: number;
  };
}

export interface BoatDesktopAccess {
  readonly binding: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly sandboxId: string;
    readonly sourceTree: string;
    readonly leaseGeneration: string;
  };
  readonly lease: BoatLeaseAccess;
  readonly ssh: BoatSshTunnel.BoatSshAuthorization;
  readonly viewer: BoatDesktopDescriptor["viewer"] & { readonly tabId: string };
  readonly actor: BoatDesktopDescriptor["actor"];
}

export interface BoatDesktopViewer {
  readonly activate: Effect.Effect<void, BoatError>;
  readonly touch: Effect.Effect<void, BoatError>;
  readonly deactivate: Effect.Effect<void>;
  readonly disconnect: Effect.Effect<void>;
}

export interface BoatExpiryWarning {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly sandboxId: string;
  readonly expiresAt: string;
}

export class BoatService extends Context.Service<
  BoatService,
  {
    readonly expiring: Stream.Stream<BoatExpiryWarning>;
    readonly transfer: (
      input: BoatTransferInput,
      session: AuthenticatedSession,
    ) => Effect.Effect<BoatTransferReceipt, BoatError | EnvironmentAuthorizationError>;
    readonly reconcile: () => Effect.Effect<void, BoatError>;
    readonly configureDefaults: (defaults: BoatDefaults) => Effect.Effect<BoatState, BoatError>;
    readonly read: (
      projectId?: ProjectId,
      analytics?: BoatAnalyticsInput,
    ) => Effect.Effect<BoatState, BoatError>;
    readonly isEnabled: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly assertActiveLease: (
      target: { readonly requestId: string; readonly sandboxId: string },
      callerThreadId: ThreadId,
    ) => Effect.Effect<BoatLeaseAccess, BoatError, Scope.Scope>;
    readonly openDesktopAccess: (
      target: { readonly requestId: string; readonly sandboxId: string },
      callerThreadId: ThreadId,
      descriptor: BoatDesktopDescriptor,
    ) => Effect.Effect<BoatDesktopAccess, BoatError>;
    readonly getDesktopAccess: (
      binding: BoatDesktopAccess["binding"],
      callerThreadId: ThreadId,
    ) => Effect.Effect<BoatDesktopAccess, BoatError>;
    readonly registerDesktopViewer: (
      binding: BoatDesktopAccess["binding"],
      callerThreadId: ThreadId,
      viewer: { readonly tabId: string; readonly viewerId: string },
    ) => Effect.Effect<BoatDesktopViewer, BoatError, Scope.Scope>;
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
  const devices = yield* DeviceService;
  const projections = yield* ProjectionStoreV2;
  const tunnels = yield* BoatSshTunnel.make;
  const serviceScope = yield* Effect.scope;
  const privatePreviews = new Map<
    string,
    {
      scope: Scope.Closeable;
      lease: BoatLeaseAccess;
      tabId: string | null;
    }
  >();
  const privateDesktopPreviews = new Map<
    string,
    {
      readonly scope: Scope.Closeable;
      readonly ended: Deferred.Deferred<void>;
      access: BoatDesktopAccess | null;
      readonly viewers: Map<string, { activeUntil: number }>;
    }
  >();
  const privateAndroidPreviews = new Map<
    string,
    {
      scope: Scope.Closeable;
      lease: BoatLeaseAccess;
      target: NonNullable<BoatProjectConfig["privateAndroidTarget"]>;
      session: DeviceSession | null;
    }
  >();
  const lock = yield* Semaphore.make(1);
  const expiryWarnings = yield* PubSub.sliding<BoatExpiryWarning>(128);
  const leaseChanges = yield* PubSub.unbounded<{
    ledger: typeof Ledger.Type;
    work: typeof Work.Type;
    generation: number;
  }>();
  let leaseGeneration = 0;
  const resumeInFlight = new Set<string>();
  const prepareInFlight = new Set<string>();
  const transfersInFlight = new Set<string>();
  const operationsInFlight = new Map<string, number>();
  const filename = path.join(config.stateDir, "boat.json");
  const workFilename = path.join(config.stateDir, "boat-work.json");
  const workLock = yield* Semaphore.make(1);
  let work: typeof Work.Type = yield* fs.exists(workFilename).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs
            .readFileString(workFilename)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Work))))
        : Effect.succeed({}),
    ),
    Effect.mapError(storageError),
  );
  const saveWork = Effect.fn("BoatService.saveWork")(function* (next: typeof Work.Type) {
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(`${workFilename}.tmp`, yield* encodeWork(next), { mode: 0o600 });
    yield* fs.rename(`${workFilename}.tmp`, workFilename);
    work = next;
    yield* PubSub.publish(leaseChanges, { ledger, work, generation: leaseGeneration });
  }, Effect.mapError(storageError));
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
            usageSamples: [],
          }),
    ),
    Effect.mapError(storageError),
  );
  // The ledger is the atomic authority for owner and source changes, including recovery.
  const applySourceBindings = (state: typeof Ledger.Type, current: typeof Work.Type) => {
    const next = { ...current };
    for (const instance of state.instances) {
      const binding = instance.sourceBinding;
      if (!binding) continue;
      const source = {
        projectId: instance.projectId,
        threadId: binding.proposal.target.threadId,
        workspaceRoot: binding.proposal.target.workspaceRoot,
      };
      const previous = next[instance.requestId];
      if (
        previous?.bindingRevision === binding.revision &&
        previous.source.projectId === source.projectId &&
        previous.source.threadId === source.threadId &&
        previous.source.workspaceRoot === source.workspaceRoot
      )
        continue;
      next[instance.requestId] = { source, commands: [], bindingRevision: binding.revision };
    }
    return next;
  };
  work = applySourceBindings(ledger, work);
  const save = Effect.fn("BoatService.save")(function* (next: typeof Ledger.Type) {
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    const json = yield* encodeLedger(next);
    const temp = `${filename}.tmp`;
    yield* fs.writeFileString(temp, json, { mode: 0o600 });
    yield* fs.rename(temp, filename);
    ledger = next;
    work = applySourceBindings(ledger, work);
    yield* PubSub.publish(leaseChanges, { ledger, work, generation: leaseGeneration });
  }, Effect.mapError(storageError));
  const updateInstance = Effect.fn("BoatService.updateInstance")(
    (
      target: Pick<BoatInstance, "requestId" | "projectId">,
      update: Partial<StoredInstance> | ((item: StoredInstance) => Partial<StoredInstance>),
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* save({
            ...ledger,
            instances: ledger.instances.map((item) => {
              if (item.requestId !== target.requestId || item.projectId !== target.projectId)
                return item;
              const patch = typeof update === "function" ? update(item) : update;
              const next = { ...item, ...patch };
              const usageTimeline = recordBoatLease(item.usageTimeline, {
                at,
                threadIds: next.leases,
                running: boatUsageRunning(next.state),
              });
              return {
                ...item,
                ...patch,
                usageThreadIds: boatThreadIds({ ...item, ...patch }),
                usageTimeline,
                usageHistoryKnownSince: usageTimeline[0]?.at ?? null,
                revision:
                  item.revision +
                  (patch.state !== undefined || patch.resumeOperation !== undefined ? 1 : 0),
                // Snapshot transitions commit with the project template under this lock.
                savedSnapshot: item.savedSnapshot,
              };
            }),
          });
          return ledger.instances.find(
            (item) => item.requestId === target.requestId && item.projectId === target.projectId,
          )!;
        }),
      ),
  );
  const publicInstances = (projectId?: ProjectId) =>
    ledger.instances
      .filter((item) => !projectId || item.projectId === projectId)
      .map(
        ({
          revision: _revision,
          sourceBinding: _sourceBinding,
          resumeOperation: _resumeOperation,
          usageThreadIds: _usageThreadIds,
          usageHistoryKnownSince: _usageHistoryKnownSince,
          usageTimeline: _usageTimeline,
          ...item
        }) => item,
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
  const bindSource = Effect.fn("BoatService.bindSource")(
    (action: BoatAction, instance: StoredInstance | undefined, threadId?: ThreadId) =>
      workLock.withPermits(1)(
        Effect.gen(function* () {
          const root = yield* project(action.projectId);
          const caller = threadId
            ? yield* projections.getThreadShell(threadId).pipe(Effect.mapError(storageError))
            : null;
          if (
            threadId &&
            (!caller || caller.projectId !== action.projectId || caller.deletedAt !== null)
          )
            return yield* new BoatError({ category: "not_found" });
          const existing = work[action.requestId];
          const ownerThreadId = instance ? instance.threadId : (threadId ?? null);
          const owner =
            !existing && ownerThreadId
              ? yield* projections.getThreadShell(ownerThreadId).pipe(Effect.mapError(storageError))
              : null;
          if (!existing && ownerThreadId && (!owner || owner.projectId !== action.projectId))
            return yield* new BoatError({ category: "not_found" });
          const source = existing?.source ?? {
            projectId: action.projectId,
            threadId: ownerThreadId,
            // Before source bindings, prepare always synchronized the project root.
            workspaceRoot: path.resolve(
              instance ? root.workspaceRoot : (owner?.worktreePath ?? root.workspaceRoot),
            ),
          };
          if (source.projectId !== action.projectId)
            return yield* new BoatError({ category: "conflict" });
          if (existing && caller && source.threadId === null)
            return yield* new BoatError({ category: "conflict" });
          const moved =
            caller &&
            path.resolve(caller.worktreePath ?? root.workspaceRoot) !== source.workspaceRoot;
          if (caller && (source.threadId !== null || moved)) {
            if (moved && (action.action === "prepare" || action.action === "renew"))
              return yield* new BoatError({ category: "conflict" });
            let ancestor = caller;
            const visited = new Set<ThreadId>();
            while (ancestor.id !== source.threadId) {
              if (
                visited.has(ancestor.id) ||
                visited.size >= 64 ||
                ancestor.lineage.relationshipToParent !== "subagent" ||
                !ancestor.lineage.parentThreadId
              )
                return yield* new BoatError({ category: "conflict" });
              visited.add(ancestor.id);
              const parent = yield* projections
                .getThreadShell(ancestor.lineage.parentThreadId)
                .pipe(Effect.mapError(storageError));
              if (!parent || parent.projectId !== action.projectId)
                return yield* new BoatError({ category: "not_found" });
              ancestor = parent;
            }
            // A moved owner cannot silently rebind its existing machine either.
            if (moved && caller.id === source.threadId)
              return yield* new BoatError({ category: "conflict" });
          }
          if (!existing) yield* saveWork({ ...work, [action.requestId]: { source, commands: [] } });
          return source;
        }),
      ),
  );
  const projectSettings = (projectId: ProjectId) => {
    const value = ledger.projects[projectId] ?? DEFAULT_BOAT_PROJECT;
    return value.inheritDefaults ? { ...value, ...ledger.defaults } : value;
  };
  const previewLock = yield* Semaphore.make(1);
  const attachPrivateAndroid = Effect.fn("BoatService.attachPrivateAndroid")(function* (
    current: StoredInstance,
    token: Redacted.Redacted<string>,
    callerThreadId?: ThreadId,
  ) {
    const target = projectSettings(current.projectId).privateAndroidTarget;
    const source = work[current.requestId]?.source;
    if (!callerThreadId || !current.sandboxId || !target || source?.projectId !== current.projectId)
      return yield* new BoatError({ category: "conflict" });
    yield* Effect.scoped(
      assertActiveLease(
        { requestId: current.requestId, sandboxId: current.sandboxId },
        callerThreadId,
      ),
    );
    const web = privatePreviews.get(current.requestId);
    if (web) yield* Scope.close(web.scope, Exit.void);
    const previous = privateAndroidPreviews.get(current.requestId);
    if (previous) {
      const valid = yield* previous.lease.check.pipe(Effect.isSuccess);
      if (
        valid &&
        previous.lease.threadId === callerThreadId &&
        previous.target.hostId === target.hostId &&
        previous.target.deviceId === target.deviceId &&
        previous.session &&
        (yield* devices.state).sessions.includes(previous.session)
      )
        return current;
      yield* Scope.close(previous.scope, Exit.void);
    }
    const scope = yield* Scope.fork(serviceScope, "sequential");
    return yield* Effect.gen(function* () {
      const lease = yield* assertActiveLease(
        { requestId: current.requestId, sandboxId: current.sandboxId! },
        callerThreadId,
      );
      const entry = { scope, lease, target, session: null as DeviceSession | null };
      privateAndroidPreviews.set(current.requestId, entry);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (privateAndroidPreviews.get(current.requestId) !== entry) return;
          privateAndroidPreviews.delete(current.requestId);
          yield* updateInstance(current, (latest) =>
            latest.sandboxId === lease.sandboxId ? { previewUrl: null, previewTabId: null } : {},
          ).pipe(Effect.orElseSucceed(() => undefined));
        }),
      );
      yield* lease.revoked.pipe(
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.forkIn(serviceScope),
      );
      const opened = yield* Effect.raceFirst(
        Effect.gen(function* () {
          const binding = yield* tunnels.authorize(lease, token);
          return yield* devices
            .openScopedSsh(
              {
                threadId: lease.threadId,
                hostId: target.hostId,
                deviceId: target.deviceId,
                platform: "android",
                boot: false,
                includeAgentTarget: true,
              },
              {
                ...binding,
                check: binding.check.pipe(
                  Effect.mapError(
                    (cause) =>
                      new DeviceHostUnavailableError({
                        hostId: target.hostId,
                        reason: "The Boat lease has ended.",
                        cause,
                      }),
                  ),
                ),
              },
              { workspaceRoot: source.workspaceRoot },
            )
            .pipe(Effect.mapError(() => new BoatError({ category: "provider" })));
        }),
        lease.revoked.pipe(Effect.andThen(Effect.fail(new BoatError({ category: "conflict" })))),
      );
      entry.session = opened.session;
      yield* lease.check;
      return yield* updateInstance(current, {
        threadId: lease.threadId,
        previewUrl: null,
        previewTabId: null,
      });
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  });
  const attachPrivatePreview = Effect.fn("BoatService.attachPrivatePreview")(function* (
    current: StoredInstance,
    token: Redacted.Redacted<string>,
    callerThreadId?: ThreadId,
  ) {
    if (callerThreadId && current.sandboxId)
      yield* Effect.scoped(
        assertActiveLease(
          { requestId: current.requestId, sandboxId: current.sandboxId },
          callerThreadId,
        ),
      );
    const desktop = privateDesktopPreviews.get(current.requestId);
    if (desktop) yield* closeDesktopAccess(desktop);
    const android = privateAndroidPreviews.get(current.requestId);
    if (android) {
      if (!callerThreadId) return yield* new BoatError({ category: "conflict" });
      yield* Scope.close(android.scope, Exit.void);
    }
    const previous = privatePreviews.get(current.requestId);
    if (previous) {
      const valid = yield* previous.lease.check.pipe(Effect.isSuccess);
      if (valid && (!callerThreadId || previous.lease.threadId === callerThreadId)) {
        const listed = yield* previews.list({ threadId: previous.lease.threadId });
        if (previous.tabId && listed.sessions.some((session) => session.tabId === previous.tabId)) {
          yield* previews
            .requestReveal({
              threadId: previous.lease.threadId,
              tabId: previous.tabId,
              force: true,
            })
            .pipe(Effect.mapError(() => new BoatError({ category: "provider" })));
          return current;
        }
      }
      yield* Scope.close(previous.scope, Exit.void);
    }
    if (!callerThreadId || !current.sandboxId)
      return yield* new BoatError({ category: "conflict" });
    const scope = yield* Scope.fork(serviceScope, "sequential");
    return yield* Effect.gen(function* () {
      const lease = yield* assertActiveLease(
        {
          requestId: current.requestId,
          sandboxId: current.sandboxId!,
        },
        callerThreadId,
      );
      const entry = { scope, lease, tabId: null as string | null };
      privatePreviews.set(current.requestId, entry);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (privatePreviews.get(current.requestId) !== entry) return;
          privatePreviews.delete(current.requestId);
          if (entry.tabId)
            yield* previews
              .close({
                threadId: lease.threadId,
                tabId: PreviewTabId.make(entry.tabId),
              })
              .pipe(Effect.orElseSucceed(() => undefined));
          yield* updateInstance(current, (latest) =>
            latest.sandboxId === lease.sandboxId ? { previewUrl: null, previewTabId: null } : {},
          ).pipe(Effect.orElseSucceed(() => undefined));
        }),
      );
      yield* lease.revoked.pipe(
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.forkIn(serviceScope),
      );
      const tunnel = yield* Effect.raceFirst(
        tunnels.open(lease, token, projectSettings(current.projectId).port),
        lease.revoked.pipe(Effect.andThen(Effect.fail(new BoatError({ category: "conflict" })))),
      );
      yield* tunnel.exited.pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.forkIn(serviceScope),
      );
      const credential = yield* secrets
        .get(`boat-dev-${current.requestId}`)
        .pipe(Effect.mapError(storageError));
      const url = new URL(tunnel.url);
      if (Option.isSome(credential)) {
        url.pathname = "/pair";
        url.hash = `token=${Buffer.from(credential.value).toString("hex")}`;
      }
      yield* lease.check;
      const opened = yield* previews
        .open({
          threadId: lease.threadId,
          url: url.toString(),
          runtime: "server",
          reveal: true,
        })
        .pipe(Effect.mapError(() => new BoatError({ category: "provider" })));
      entry.tabId = opened.tabId;
      yield* lease.check;
      return yield* updateInstance(current, {
        threadId: lease.threadId,
        previewUrl: null,
        previewTabId: opened.tabId,
      });
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  });
  const closeDesktopAccess = Effect.fn("BoatService.closeDesktopAccess")(
    (entry: {
      readonly scope: Scope.Closeable;
      readonly ended: Deferred.Deferred<void>;
      readonly viewers: Map<string, { activeUntil: number }>;
    }) =>
      Effect.sync(() => entry.viewers.clear()).pipe(
        Effect.andThen(Deferred.succeed(entry.ended, undefined)),
        Effect.andThen(Scope.close(entry.scope, Exit.void)),
      ),
  );
  const getDesktopAccess = Effect.fn("BoatService.getDesktopAccess")(function* (
    binding: BoatDesktopAccess["binding"],
    callerThreadId: ThreadId,
  ) {
    const access = privateDesktopPreviews.get(binding.requestId)?.access;
    if (!access || access.binding !== binding || binding.threadId !== callerThreadId)
      return yield* new BoatError({ category: "conflict" });
    yield* access.lease.check;
    const listed = yield* previews.list({ threadId: callerThreadId });
    if (!listed.sessions.some((session) => session.tabId === access.viewer.tabId))
      return yield* new BoatError({ category: "conflict" });
    yield* access.lease.check;
    if (privateDesktopPreviews.get(binding.requestId)?.access !== access)
      return yield* new BoatError({ category: "conflict" });
    return access;
  });
  const registerDesktopViewer = Effect.fn("BoatService.registerDesktopViewer")(function* (
    binding: BoatDesktopAccess["binding"],
    callerThreadId: ThreadId,
    viewer: { readonly tabId: string; readonly viewerId: string },
  ) {
    const access = yield* getDesktopAccess(binding, callerThreadId);
    const entry = privateDesktopPreviews.get(binding.requestId);
    if (
      !entry ||
      viewer.tabId !== access.viewer.tabId ||
      !viewer.viewerId ||
      viewer.viewerId.length > 256 ||
      entry.viewers.has(viewer.viewerId)
    )
      return yield* new BoatError({ category: "conflict" });
    return yield* Effect.gen(function* () {
      if (
        privateDesktopPreviews.get(binding.requestId) !== entry ||
        entry.viewers.has(viewer.viewerId)
      )
        return yield* new BoatError({ category: "conflict" });
      const usage = { activeUntil: 0 };
      entry.viewers.set(viewer.viewerId, usage);
      const disconnect = Effect.sync(() => {
        if (entry.viewers.get(viewer.viewerId) === usage) entry.viewers.delete(viewer.viewerId);
      });
      yield* Effect.addFinalizer(() => disconnect);
      // Accepted input is frequent; refresh uses in-memory checks without per-input spans or I/O.
      const refresh = Effect.fnUntraced(function* (requireActive: boolean) {
        const now = yield* Clock.currentTimeMillis;
        const ended = yield* Deferred.isDone(entry.ended);
        const instance = ledger.instances.find((item) => item.requestId === binding.requestId);
        if (
          ended ||
          privateDesktopPreviews.get(binding.requestId) !== entry ||
          entry.viewers.get(viewer.viewerId) !== usage ||
          entry.access !== access ||
          instance?.projectId !== binding.projectId ||
          instance.sandboxId !== binding.sandboxId ||
          !["ready", "idle", "running"].includes(instance.state) ||
          !instance.leases.includes(binding.threadId) ||
          !projectSettings(binding.projectId).enabled ||
          projectSettings(binding.projectId).webAccess !== "private" ||
          work[binding.requestId]?.sourceTree !== binding.sourceTree ||
          !Number.isFinite(Date.parse(access.lease.expiresAt)) ||
          Date.parse(access.lease.expiresAt) <= now ||
          Date.parse(instance.expiresAt) <= now ||
          (requireActive && usage.activeUntil <= now)
        )
          return yield* new BoatError({ category: "conflict" });
        usage.activeUntil = Math.min(
          now + 60_000,
          Date.parse(access.lease.expiresAt),
          Date.parse(instance.expiresAt),
        );
      });
      return {
        activate: refresh(false),
        touch: refresh(true),
        deactivate: Effect.sync(() => {
          if (entry.viewers.get(viewer.viewerId) === usage) usage.activeUntil = 0;
        }),
        disconnect,
      } satisfies BoatDesktopViewer;
    }).pipe(Effect.uninterruptible);
  });
  const openDesktopAccess = Effect.fn("BoatService.openDesktopAccess")(
    (
      target: { readonly requestId: string; readonly sandboxId: string },
      callerThreadId: ThreadId,
      descriptor: BoatDesktopDescriptor,
    ) =>
      previewLock.withPermits(1)(
        Effect.gen(function* () {
          if (
            !Number.isInteger(descriptor.viewer.remotePort) ||
            descriptor.viewer.remotePort < 1 ||
            descriptor.viewer.remotePort > 65535 ||
            !descriptor.viewer.path.startsWith("/") ||
            descriptor.viewer.path.startsWith("//") ||
            descriptor.viewer.path.includes("\\") ||
            descriptor.viewer.path.length > 2048 ||
            !descriptor.actor.commandPath.startsWith("/") ||
            /[\r\n\0]/.test(descriptor.actor.commandPath) ||
            !/^[a-f0-9]{64}$/.test(descriptor.actor.sha256) ||
            !descriptor.actor.expectedServerName ||
            !Number.isInteger(descriptor.actor.protocolRevision) ||
            descriptor.actor.protocolRevision < 1
          )
            return yield* new BoatError({ category: "conflict" });
          const previous = privateDesktopPreviews.get(target.requestId);
          if (previous?.access) {
            const access = previous.access;
            if (yield* access.lease.check.pipe(Effect.isSuccess)) {
              if (
                access.binding.threadId !== callerThreadId ||
                access.binding.sandboxId !== target.sandboxId
              )
                return yield* new BoatError({ category: "conflict" });
              const listed = yield* previews.list({ threadId: callerThreadId });
              if (
                access.viewer.remotePort === descriptor.viewer.remotePort &&
                access.viewer.path === descriptor.viewer.path &&
                access.actor.commandPath === descriptor.actor.commandPath &&
                access.actor.sha256 === descriptor.actor.sha256 &&
                access.actor.expectedServerName === descriptor.actor.expectedServerName &&
                access.actor.protocolRevision === descriptor.actor.protocolRevision &&
                listed.sessions.some((session) => session.tabId === access.viewer.tabId)
              ) {
                yield* previews
                  .requestReveal({
                    threadId: callerThreadId,
                    tabId: access.viewer.tabId,
                    force: true,
                  })
                  .pipe(Effect.mapError(() => new BoatError({ category: "provider" })));
                yield* access.lease.check;
                return access;
              }
            }
          }
          const scope = yield* Scope.fork(serviceScope, "sequential");
          const ended = yield* Deferred.make<void>();
          const lifecycle = { scope, ended, viewers: new Map<string, { activeUntil: number }>() };
          return yield* Effect.gen(function* () {
            const underlying = yield* assertActiveLease(target, callerThreadId);
            const lease: BoatLeaseAccess = {
              ...underlying,
              check: Effect.gen(function* () {
                if (yield* Deferred.isDone(ended))
                  return yield* new BoatError({ category: "conflict" });
                yield* underlying.check;
              }),
              revoked: Effect.raceFirst(underlying.revoked, Deferred.await(ended)),
            };
            if (!lease.sourceTree || projectSettings(lease.projectId).webAccess !== "private")
              return yield* new BoatError({ category: "conflict" });
            const token = yield* key;
            if (previous) yield* closeDesktopAccess(previous);
            const web = privatePreviews.get(target.requestId);
            if (web) yield* Scope.close(web.scope, Exit.void);
            const android = privateAndroidPreviews.get(target.requestId);
            if (android) yield* Scope.close(android.scope, Exit.void);
            const entry = { ...lifecycle, access: null as BoatDesktopAccess | null };
            let tabId: string | null = null;
            privateDesktopPreviews.set(target.requestId, entry);
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (privateDesktopPreviews.get(target.requestId) !== entry) return;
                privateDesktopPreviews.delete(target.requestId);
                if (tabId)
                  yield* previews
                    .close({ threadId: callerThreadId, tabId: PreviewTabId.make(tabId) })
                    .pipe(Effect.orElseSucceed(() => undefined));
                yield* updateInstance(
                  { projectId: lease.projectId, requestId: target.requestId },
                  (current) =>
                    current.sandboxId === target.sandboxId && current.previewTabId === tabId
                      ? { previewTabId: null, previewUrl: null }
                      : {},
                ).pipe(Effect.orElseSucceed(() => undefined));
              }),
            );
            yield* lease.revoked.pipe(
              Effect.andThen(closeDesktopAccess(lifecycle)),
              Effect.forkIn(serviceScope),
            );
            const ssh = yield* Effect.raceFirst(
              tunnels.authorize(lease, token),
              lease.revoked.pipe(
                Effect.andThen(Effect.fail(new BoatError({ category: "conflict" }))),
              ),
            );
            const tunnel = yield* Effect.raceFirst(
              tunnels.openAuthorized(ssh, descriptor.viewer.remotePort),
              lease.revoked.pipe(
                Effect.andThen(Effect.fail(new BoatError({ category: "conflict" }))),
              ),
            );
            yield* tunnel.exited.pipe(
              Effect.orElseSucceed(() => undefined),
              Effect.andThen(closeDesktopAccess(lifecycle)),
              Effect.forkIn(serviceScope),
            );
            const generation = Buffer.from(
              yield* crypto.randomBytes(16).pipe(Effect.mapError(storageError)),
            ).toString("hex");
            const url = new URL(descriptor.viewer.path, tunnel.url);
            if (url.origin !== new URL(tunnel.url).origin)
              return yield* new BoatError({ category: "conflict" });
            yield* lease.check;
            const opened = yield* previews
              .open({
                threadId: callerThreadId,
                url: url.toString(),
                runtime: "server",
                reveal: true,
                automationOwner: generation,
              })
              .pipe(Effect.mapError(() => new BoatError({ category: "provider" })));
            tabId = opened.tabId;
            const binding = Object.freeze({
              projectId: lease.projectId,
              threadId: callerThreadId,
              requestId: target.requestId,
              sandboxId: target.sandboxId,
              sourceTree: lease.sourceTree,
              leaseGeneration: generation,
            });
            const access: BoatDesktopAccess = Object.freeze({
              binding,
              lease,
              ssh,
              viewer: Object.freeze({ ...descriptor.viewer, tabId }),
              actor: Object.freeze({ ...descriptor.actor }),
            });
            entry.access = access;
            yield* lease.check;
            yield* updateInstance(
              { projectId: lease.projectId, requestId: target.requestId },
              { previewTabId: tabId, previewUrl: null },
            );
            yield* Effect.addFinalizer(() => Deferred.succeed(ended, undefined));
            yield* lease.check;
            return access;
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => closeDesktopAccess(lifecycle)),
          );
        }),
      ),
  );
  const attachPreview = Effect.fn("BoatService.attachPreview")(
    (
      item: StoredInstance,
      token: Redacted.Redacted<string>,
      reveal = false,
      callerThreadId?: ThreadId,
    ) =>
      !reveal && projectSettings(item.projectId).webAccess === "private"
        ? Effect.succeed(item)
        : previewLock.withPermits(1)(
            Effect.gen(function* () {
              const current =
                ledger.instances.find(
                  (candidate) =>
                    candidate.requestId === item.requestId &&
                    candidate.projectId === item.projectId,
                ) ?? item;
              if (!current.sandboxId || inactive.has(current.state) || current.state === "deleting")
                return current;
              const settings = projectSettings(current.projectId);
              if (settings.webAccess === "private") {
                return reveal
                  ? settings.previewKind === "android"
                    ? yield* attachPrivateAndroid(current, token, callerThreadId)
                    : yield* attachPrivatePreview(current, token, callerThreadId)
                  : current;
              }
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
                    .requestReveal({
                      threadId: current.threadId,
                      tabId: existing.tabId,
                      force: true,
                    })
                    .pipe(Effect.mapError(() => new BoatError({ category: "provider" })));
              }
              return yield* updateInstance(current, (latest) =>
                latest.revision === current.revision && latest.sandboxId === current.sandboxId
                  ? { previewUrl, previewTabId }
                  : {},
              );
            }),
          ),
  );
  const analyticsLock = yield* Semaphore.make(1);
  const analyticsCache = new Map<string, { at: number; state: BoatState }>();
  let analyticsGeneration = 0;
  const readAnalytics = Effect.fn("BoatService.readAnalytics")(
    (input: BoatAnalyticsInput, projectId?: ProjectId) =>
      analyticsLock.withPermits(1)(
        Effect.gen(function* () {
          const generation = analyticsGeneration;
          const now = yield* Clock.currentTimeMillis;
          const period = boatUsageWindows(input.range, now);
          const candidates = ledger.instances
            .filter(
              (item) =>
                (!projectId || item.projectId === projectId) &&
                (!input.threadId || boatThreadIds(item).includes(input.threadId)),
            )
            .sort(
              (a, b) =>
                Number(inactive.has(a.state)) - Number(inactive.has(b.state)) ||
                b.createdAt.localeCompare(a.createdAt),
            );
          const cacheKey = encodeCacheKey([
            input,
            projectId,
            period.since,
            candidates.map((item) => [
              item.requestId,
              item.state,
              boatThreadIds(item),
              item.usageTimeline.at(-1),
            ]),
          ]);
          const cached = analyticsCache.get(cacheKey);
          if (cached && now - cached.at < 60_000) return cached.state;
          const stored = yield* secrets.get(KEY).pipe(Effect.mapError(storageError));
          const token = Option.isSome(stored)
            ? Redacted.make(new TextDecoder().decode(stored.value))
            : null;
          const samples: (typeof UsageSample.Type)[] = [];
          const observedRunning = new Map<string, boolean>();
          const activeInstances = { small: 0, default: 0, large: 0, xlarge: 0 };
          const seen = new Set<string>();
          const unique = candidates.filter((item) => {
            const id = item.sandboxId ?? item.requestId;
            if (seen.has(id)) return false;
            seen.add(id);
            if (!inactive.has(item.state)) activeInstances[item.size] += 1;
            return true;
          });
          const selected = unique.slice(0, MAX_ANALYTICS_INSTANCES);
          // At most eight VMs and eight real windows: never extrapolate a total into a curve.
          const points = yield* Effect.forEach(
            selected.flatMap((item) => period.windows.map((window) => ({ item, window }))),
            ({ item, window }) =>
              Effect.gen(function* () {
                const fallback = ledger.usageSamples
                  .filter(
                    (sample) =>
                      sample.sandboxId === item.sandboxId &&
                      sample.since === window.since &&
                      sample.until <= window.until,
                  )
                  .sort((a, b) => b.until.localeCompare(a.until))[0];
                if (Date.parse(item.createdAt) >= Date.parse(window.until)) {
                  return {
                    ...window,
                    seconds: 0,
                    dollars: 0,
                    measuredUntil: window.until,
                    recordedAt: period.until,
                    status: "measured",
                  } satisfies BoatUsagePoint;
                }
                const measured =
                  token && item.sandboxId && item.state !== "deleted"
                    ? yield* api
                        .request(
                          token,
                          `/sandboxes/${encodeURIComponent(item.sandboxId)}/usage?${new URLSearchParams(window)}`,
                        )
                        .pipe(
                          Effect.flatMap(decode(AnalyticsUsage)),
                          Effect.filterOrFail(
                            (usage) =>
                              usage.sandboxId === item.sandboxId &&
                              Number.isFinite(usage.seconds) &&
                              Number.isFinite(usage.dollars) &&
                              Date.parse(usage.since) === Date.parse(window.since) &&
                              Date.parse(usage.until) === Date.parse(window.until),
                            () => new BoatError({ category: "provider" }),
                          ),
                          Effect.catchTags({ BoatError: () => Effect.succeed(null) }),
                        )
                    : null;
                if (measured) {
                  if (window.until === period.until)
                    observedRunning.set(item.requestId, measured.running);
                  const sample = {
                    sandboxId: measured.sandboxId,
                    ...window,
                    seconds: measured.seconds,
                    dollars: measured.dollars,
                    recordedAt: period.until,
                  };
                  samples.push(sample);
                  return {
                    ...window,
                    seconds: sample.seconds,
                    dollars: sample.dollars,
                    measuredUntil: sample.until,
                    recordedAt: sample.recordedAt,
                    status: "measured",
                  } satisfies BoatUsagePoint;
                }
                return {
                  ...window,
                  seconds: fallback?.seconds ?? null,
                  dollars: fallback?.dollars ?? null,
                  measuredUntil: fallback?.until ?? null,
                  recordedAt: fallback?.recordedAt ?? null,
                  status: fallback ? "stale" : "unavailable",
                } satisfies BoatUsagePoint;
              }),
            { concurrency: 4 },
          );
          if (generation !== analyticsGeneration)
            return yield* new BoatError({ category: "conflict" });
          if (samples.length > 0) {
            yield* lock.withPermits(1)(
              Effect.suspend(() => {
                if (generation !== analyticsGeneration)
                  return Effect.fail(new BoatError({ category: "conflict" }));
                const retained = new Map(
                  ledger.usageSamples.map((sample) => [
                    `${sample.sandboxId}:${sample.since}:${sample.until}`,
                    sample,
                  ]),
                );
                for (const sample of samples)
                  retained.set(`${sample.sandboxId}:${sample.since}:${sample.until}`, sample);
                return save({
                  ...ledger,
                  usageSamples: [...retained.values()]
                    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
                    .slice(0, MAX_USAGE_SAMPLES),
                });
              }),
            );
          }
          const analytics: BoatAnalytics = {
            range: input.range,
            since: period.since,
            until: period.until,
            generatedAt: period.until,
            omittedInstances: unique.length - selected.length,
            activeInstances,
            instances: selected.map((item, index) => {
              const instancePoints = points.slice(
                index * period.windows.length,
                (index + 1) * period.windows.length,
              );
              return {
                requestId: item.requestId,
                projectId: item.projectId,
                sandboxId: item.sandboxId,
                size: item.size,
                state: observedRunning.has(item.requestId)
                  ? observedRunning.get(item.requestId)
                    ? "running"
                    : "stopped"
                  : item.state,
                threadIds: boatThreadIds(item),
                historyKnownSince: item.usageHistoryKnownSince,
                points: instancePoints,
                threadPoints: input.threadId
                  ? instancePoints.map((point) =>
                      estimateBoatThreadUsage(
                        point,
                        item.usageTimeline,
                        item.createdAt,
                        input.threadId!,
                      ),
                    )
                  : [],
                ...boatLifecycleCounts(
                  item.usageTimeline,
                  period.since,
                  period.until,
                  item.createdAt,
                ),
              };
            }),
          };
          for (const item of selected) {
            const running = observedRunning.get(item.requestId);
            if (running !== undefined) {
              activeInstances[item.size] += Number(running) - Number(!inactive.has(item.state));
            }
          }
          const state: BoatState = {
            configured: token !== null,
            defaults: ledger.defaults,
            projects: ledger.projects,
            account: null,
            instances: [],
            analytics,
          };
          if (generation !== analyticsGeneration)
            return yield* new BoatError({ category: "conflict" });
          if (analyticsCache.size >= 20) analyticsCache.delete(analyticsCache.keys().next().value!);
          analyticsCache.set(cacheKey, { at: now, state });
          return state;
        }),
      ),
  );
  const read = Effect.fn("BoatService.read")(function* (
    projectId?: ProjectId,
    analytics?: BoatAnalyticsInput,
  ) {
    if (analytics) return yield* readAnalytics(analytics, projectId);
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
        instances: publicInstances(projectId),
      };
    const token = Redacted.make(new TextDecoder().decode(stored.value));
    const limits = yield* api.request(token, "/limits").pipe(Effect.flatMap(decode(Limits)));
    yield* Effect.forEach(
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
            return yield* updateInstance(item, (current) =>
              current.revision === item.revision &&
              current.deletionOperationId === item.deletionOperationId
                ? { state: result.operation.status === "completed" ? "deleted" : "deleting" }
                : {},
            );
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
            return yield* updateInstance(item, (current) =>
              current.revision === item.revision &&
              current.sandboxId === item.sandboxId &&
              !current.deletionOperationId
                ? { state: "deleted", processId: null, previewUrl: null, resumeOperation: null }
                : {},
            );
          }
          const usage = yield* api
            .request(
              token,
              `/sandboxes/${encodeURIComponent(item.sandboxId)}/usage?since=${encodeURIComponent(`${period}-01T00:00:00Z`)}`,
            )
            .pipe(Effect.flatMap(decode(Usage)));
          const stopped = ["archived", "stopped"].includes(remote.sandbox.state);
          const stoppedAt = DateTime.formatIso(yield* DateTime.now);
          const next = yield* updateInstance(item, (current) => {
            if (
              current.revision !== item.revision ||
              current.sandboxId !== item.sandboxId ||
              current.deletionOperationId
            )
              return {};
            // A stopped GET cannot settle an outstanding resume POST.
            const pending =
              current.resumeOperation !== null &&
              (stopped || resumeInFlight.has(current.requestId));
            return {
              state: pending ? current.state : remote.sandbox.state,
              costUsd: usage.dollars,
              stoppedAt: pending
                ? current.stoppedAt
                : stopped
                  ? (current.stoppedAt ?? stoppedAt)
                  : null,
              ...(current.resumeOperation && !pending ? { resumeOperation: null } : {}),
            };
          });
          if (next.threadId && next.processId !== null && !inactive.has(next.state)) {
            if (next.previewUrl) return yield* attachPreview(next, token);
            const settings = projectSettings(item.projectId);
            const probe = yield* api
              .request(token, `/sandboxes/${encodeURIComponent(item.sandboxId)}/commands`, "POST", {
                command:
                  settings.previewKind === "android" && settings.webAccess !== "private"
                    ? "/home/user/Android/Sdk/platform-tools/adb shell getprop sys.boot_completed | grep -q '^1'"
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
    for (const item of ledger.instances.filter(
      (item) => !projectId || item.projectId === projectId,
    )) {
      if (item.savedSnapshot?.status !== "saving") continue;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const current = ledger.instances.find((entry) => entry.requestId === item.requestId);
          if (current?.savedSnapshot?.status !== "saving") return;
          const { snapshot } = yield* api
            .request(token, `/saved-snapshots/${encodeURIComponent(current.savedSnapshot.name)}`)
            .pipe(Effect.flatMap(decode(SnapshotResponse)));
          if (snapshot.name !== current.savedSnapshot.name)
            return yield* new BoatError({ category: "provider" });
          yield* save({
            ...ledger,
            instances: ledger.instances.map((entry) =>
              entry.requestId === item.requestId && entry.projectId === item.projectId
                ? { ...entry, savedSnapshot: snapshot }
                : entry,
            ),
            projects:
              snapshot.status === "ready" && ledger.projects[item.projectId]
                ? {
                    ...ledger.projects,
                    [item.projectId]: {
                      ...ledger.projects[item.projectId]!,
                      snapshot: snapshot.name,
                    },
                  }
                : ledger.projects,
          });
        }),
      );
    }
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
      instances: publicInstances(projectId),
    };
  });
  const connect = Effect.fn("BoatService.connect")(function* (apiKey: Redacted.Redacted<string>) {
    if (!Redacted.value(apiKey).startsWith("boat_"))
      return yield* new BoatError({ category: "invalid_key" });
    yield* api.request(apiKey, "/limits").pipe(Effect.flatMap(decode(Limits)));
    yield* secrets
      .set(KEY, new TextEncoder().encode(Redacted.value(apiKey)))
      .pipe(Effect.mapError(storageError));
    analyticsCache.clear();
    analyticsGeneration++;
    leaseGeneration++;
    yield* PubSub.publish(leaseChanges, { ledger, work, generation: leaseGeneration });
    return yield* read();
  });
  const disconnect = Effect.gen(function* () {
    if (ledger.instances.some((item) => !inactive.has(item.state)))
      return yield* new BoatError({ category: "conflict" });
    yield* secrets.remove(KEY).pipe(Effect.mapError(storageError));
    analyticsCache.clear();
    analyticsGeneration++;
    leaseGeneration++;
    yield* PubSub.publish(leaseChanges, { ledger, work, generation: leaseGeneration });
  });
  const configure = Effect.fn("BoatService.configure")(function* (
    projectId: ProjectId,
    settings: BoatProjectConfig,
  ) {
    if (
      (settings.webAccess === "private" &&
        settings.previewKind === "android" &&
        !settings.privateAndroidTarget) ||
      (settings.webAccess !== projectSettings(projectId).webAccess &&
        ledger.instances.some(
          (item) => item.projectId === projectId && item.sandboxId && item.state !== "deleted",
        ))
    )
      return yield* new BoatError({ category: "conflict" });
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
        const command = viteVersion ? "./node_modules/.bin/vp" : manager;
        const install = viteVersion
          ? `npm install --prefix $HOME/.crew-tools --no-save vite-plus@${viteVersion}\n"$HOME/.crew-tools/node_modules/.bin/vp" install --frozen-lockfile\nexport PATH="$PWD/node_modules/.bin:$PATH"\nif [ -n "\${GITHUB_PATH:-}" ]; then echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"; fi`
          : manager === "npm"
            ? "npm ci"
            : `corepack ${manager} install --frozen-lockfile`;
        const crew = manifest.scripts.dev.includes("scripts/dev-runner.ts");
        settings = {
          ...settings,
          setupCommand: settings.setupCommand.trim() || install,
          devCommand: crew
            ? settings.previewKind === "android" && settings.webAccess !== "private"
              ? ANDROID_CREW_DEV
              : "T3CODE_PORT_OFFSET=0 ./node_modules/.bin/vp run dev --no-seed"
            : settings.previewKind === "android" &&
                settings.webAccess !== "private" &&
                manifest.dependencies?.expo
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
    let managedWorkflow = false;
    if (exists) {
      const current = yield* fs.readFileString(workflow).pipe(Effect.mapError(storageError));
      managedWorkflow = current.startsWith(marker);
      if (settings.ciEnabled && !managedWorkflow)
        return yield* new BoatError({ category: "conflict" });
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
    } else if (managedWorkflow) {
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
  const executeOperation = Effect.fn("BoatService.operate")(function* (
    action: BoatAction,
    threadId?: ThreadId,
  ) {
    // Owned machines still need cleanup after their project has been removed.
    if (action.action !== "stop" && action.action !== "delete") yield* project(action.projectId);
    const agentThreadId = threadId;
    threadId ??= action.threadId;
    const caller = threadId
      ? yield* projections.getThreadShell(threadId).pipe(Effect.mapError(storageError))
      : null;
    if (threadId && (!caller || caller.projectId !== action.projectId || caller.deletedAt !== null))
      return yield* new BoatError({ category: "not_found" });
    const token = yield* key;
    const settings = projectSettings(action.projectId);
    const ttlMinutes =
      "ttlMinutes" in action ? (action.ttlMinutes ?? settings.ttlMinutes) : settings.ttlMinutes;
    if (
      (action.action === "prepare" || action.action === "preview") &&
      settings.webAccess === "private" &&
      settings.previewKind === "android" &&
      !settings.privateAndroidTarget
    )
      return yield* new BoatError({ category: "conflict" });
    if (
      ledger.instances.some(
        (item) => item.requestId === action.requestId && item.projectId !== action.projectId,
      )
    )
      return yield* new BoatError({ category: "conflict" });
    let instance = ledger.instances.find(
      (item) => item.requestId === action.requestId && item.projectId === action.projectId,
    );
    if (agentThreadId && (instance || work[action.requestId])) {
      const binding = work[action.requestId]?.source;
      const ownerThreadId = binding ? binding.threadId : instance?.threadId;
      if (!caller || !ownerThreadId || (binding && binding.projectId !== action.projectId))
        return yield* new BoatError({ category: "conflict" });
      let ancestor = caller;
      const visited = new Set<ThreadId>();
      while (ancestor.id !== ownerThreadId) {
        if (
          visited.has(ancestor.id) ||
          visited.size >= 64 ||
          ancestor.lineage.relationshipToParent !== "subagent" ||
          !ancestor.lineage.parentThreadId
        )
          return yield* new BoatError({ category: "conflict" });
        visited.add(ancestor.id);
        const parent = yield* projections
          .getThreadShell(ancestor.lineage.parentThreadId)
          .pipe(Effect.mapError(storageError));
        if (!parent || parent.projectId !== action.projectId || parent.deletedAt !== null)
          return yield* new BoatError({ category: "not_found" });
        ancestor = parent;
      }
    }
    const source = ["start", "prepare", "exec", "resume", "renew"].includes(action.action)
      ? yield* bindSource(action, instance, threadId)
      : null;
    if (action.action === "start") {
      if (instance?.sandboxId) {
        if (agentThreadId && !inactive.has(instance.state))
          yield* updateInstance(action, (current) => ({
            leases: Array.from(new Set([...current.leases, agentThreadId])),
          }));
        return yield* read(action.projectId);
      }
      const status = instance ? null : yield* read(action.projectId);
      const reservation = (ttlMinutes / 60) * rates[settings.size];
      const now = yield* Clock.currentTimeMillis;
      instance ??= {
        requestId: action.requestId,
        projectId: action.projectId,
        revision: 0,
        sourceBinding: null,
        resumeOperation: null,
        savedSnapshot: null,
        sandboxId: null,
        size: settings.size,
        state: "provisioning",
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + ttlMinutes * 60000)),
        costUsd: 0,
        threadId: threadId ?? null,
        previewTabId: null,
        leases: agentThreadId ? [agentThreadId] : [],
        usageThreadIds: Array.from(
          new Set([...(threadId ? [threadId] : []), ...(agentThreadId ? [agentThreadId] : [])]),
        ),
        usageHistoryKnownSince: DateTime.formatIso(DateTime.makeUnsafe(now)),
        usageTimeline: [
          {
            at: DateTime.formatIso(DateTime.makeUnsafe(now)),
            threadIds: agentThreadId ? [agentThreadId] : [],
            running: false,
          },
        ],
        stoppedAt: null,
        processId: null,
        deletionOperationId: null,
        output: "",
        snapshot: settings.snapshot,
        previewUrl: null,
      };
      const reserved = instance;
      instance = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = ledger.instances.find((item) => item.requestId === action.requestId);
          if (existing) {
            if (existing.projectId !== action.projectId)
              return yield* new BoatError({ category: "conflict" });
            return existing;
          }
          if (!status?.account?.canStart || !status.account.sizes.includes(settings.size))
            return yield* new BoatError({ category: "capacity" });
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
          return reserved;
        }),
      );
      if (instance.sandboxId) return yield* read(action.projectId);
      if (instance.state !== "provisioning") return yield* new BoatError({ category: "conflict" });
      if (now - Date.parse(instance.createdAt) > 23 * 3600000)
        return yield* new BoatError({ category: "conflict" });
      const createReservation = instance;
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
                yield* updateInstance(action, (current) =>
                  !current.sandboxId &&
                  current.state === "provisioning" &&
                  current.revision === createReservation.revision &&
                  current.createdAt === createReservation.createdAt
                    ? { state: "error" }
                    : {},
                );
              return yield* error;
            }),
          }),
        );
      yield* updateInstance(action, (current) =>
        !current.sandboxId &&
        current.state === "provisioning" &&
        current.revision === createReservation.revision &&
        current.createdAt === createReservation.createdAt
          ? { sandboxId: created.sandbox.id, state: created.sandbox.state }
          : {},
      );
      return yield* read(action.projectId);
    }
    if (!instance?.sandboxId) return yield* new BoatError({ category: "not_found" });
    const sandboxPath = `/sandboxes/${encodeURIComponent(instance.sandboxId)}`;
    if (
      agentThreadId &&
      ["prepare", "exec", "resume", "renew"].includes(action.action) &&
      !instance.leases.includes(agentThreadId)
    ) {
      yield* updateInstance(action, (current) => ({
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
      if (spent + (ttlMinutes / 60) * rates[instance.size] > settings.budgetUsd)
        return yield* new BoatError({ category: "budget" });
      yield* api.request(token, sandboxPath, "PATCH", { ttlSeconds: ttlMinutes * 60 });
      yield* updateInstance(action, {
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + ttlMinutes * 60000)),
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
      yield* updateInstance(action, {
        state: "deleting",
        costUsd: usage.dollars,
        deletionOperationId: result.operation.id,
        previewUrl: null,
      });
    } else if (action.action === "prepare") {
      const preparedInstance = instance;
      yield* Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (prepareInFlight.has(action.requestId))
            return Effect.fail(new BoatError({ category: "conflict" }));
          prepareInFlight.add(action.requestId);
          return Effect.void;
        }),
        () =>
          Effect.gen(function* () {
            if (settings.webAccess === "private") {
              if (!agentThreadId) return yield* new BoatError({ category: "conflict" });
              yield* Effect.scoped(
                assertActiveLease(
                  {
                    requestId: action.requestId,
                    sandboxId: preparedInstance.sandboxId!,
                  },
                  agentThreadId,
                ),
              );
            }
            const process =
              preparedInstance.processId === null
                ? null
                : yield* api
                    .request(token, `${sandboxPath}/commands/${preparedInstance.processId}`)
                    .pipe(Effect.flatMap(decode(ProcessStatus)));
            const running = process !== null && process.exitCode === undefined;
            if (!settings.devCommand.trim()) return yield* new BoatError({ category: "disabled" });
            if (settings.previewKind === "android" && settings.webAccess !== "private")
              yield* api.request(token, `${sandboxPath}/desktop?vnc=1`, "POST");
            yield* workLock.withPermits(1)(
              Effect.gen(function* () {
                const current = work[action.requestId]!;
                const { sourceTree: _sourceTree, ...unprepared } = current;
                yield* saveWork({ ...work, [action.requestId]: unprepared });
              }),
            );
            const archive = yield* fs
              .makeTempFile({ prefix: "crew-boat-", suffix: ".tar.gz" })
              .pipe(Effect.mapError(storageError));
            yield* Effect.gen(function* () {
              const indexPath = `${archive}.index`;
              const env = { GIT_INDEX_FILE: indexPath };
              const execute = (args: ReadonlyArray<string>) =>
                git
                  .execute({ operation: "boat-archive", cwd: source!.workspaceRoot, args, env })
                  .pipe(Effect.mapError(() => new BoatError({ category: "storage" })));
              const sourceTree = yield* Effect.gen(function* () {
                yield* execute(["read-tree", "HEAD"]);
                yield* execute(["add", "-A", "--", ".", ":(exclude).repos"]);
                const tree = yield* execute(["write-tree"]);
                const fingerprint = tree.stdout.trim();
                if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fingerprint))
                  return yield* new BoatError({ category: "storage" });
                yield* execute([
                  "archive",
                  "--format=tar.gz",
                  "--output",
                  archive,
                  fingerprint,
                  "--",
                  ".",
                  ":(exclude).repos",
                ]);
                return fingerprint;
              }).pipe(
                Effect.ensuring(fs.remove(indexPath).pipe(Effect.orElseSucceed(() => undefined))),
              );
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
                  content: Buffer.from(bytes.subarray(offset, offset + chunkSize)).toString(
                    "base64",
                  ),
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
                if (settings.webAccess === "private") {
                  devAuth = `export T3CODE_DEV_AUTH_TOKEN=${credential}\nexport T3CODE_DEV_WEB_HOST=127.0.0.1\nexport NODE_OPTIONS="--dns-result-order=ipv4first \${NODE_OPTIONS:-}"\n`;
                } else {
                  const hosted = yield* api
                    .request(token, `${sandboxPath}/host`, "POST", {
                      port: settings.port,
                      public: false,
                    })
                    .pipe(Effect.flatMap(decode(Hosted)));
                  devAuth = `export T3CODE_DEV_AUTH_TOKEN=${credential}\nexport T3CODE_DEV_ALLOWED_ORIGINS=${new URL(hosted.url).origin}\nexport T3CODE_DEV_ALLOWED_HOSTS=${new URL(hosted.url).hostname}\nexport T3CODE_DEV_WEB_HOST=0.0.0.0\nexport NODE_OPTIONS="--dns-result-order=ipv4first \${NODE_OPTIONS:-}"\n`;
                }
              }
              const androidSetup =
                settings.previewKind === "android" && settings.webAccess !== "private"
                  ? ANDROID_SETUP
                  : "";
              const sync = `set -eu\ncat ${chunks.join(" ")} > ${remoteArchive}\nrm ${chunks.join(" ")}\nset -- ${remoteArchive} /home/user/crew /home/user/.crew-source-files.json\n${sourceSyncScript}`;
              const result = yield* api
                .request(token, `${sandboxPath}/commands`, "POST", {
                  command: sync,
                  timeoutSeconds: 20,
                })
                .pipe(Effect.flatMap(decode(ProcessStatus)));
              if (result.exitCode !== 0) return yield* new BoatError({ category: "provider" });
              if (running) {
                yield* updateInstance(action, {
                  output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-12000),
                });
              } else {
                const script = `set -eu\n${devAuth}${androidSetup}\ncd /home/user/crew\n${settings.setupCommand}\nexport PATH="$PWD/node_modules/.bin:$PATH"\n${settings.devCommand}`;
                const started = yield* api
                  .request(token, `${sandboxPath}/commands`, "POST", {
                    command: script,
                    detached: true,
                  })
                  .pipe(Effect.flatMap(decode(Process)));
                yield* updateInstance(action, { processId: started.processId });
              }
              yield* workLock.withPermits(1)(
                Effect.gen(function* () {
                  const current = work[action.requestId]!;
                  if (
                    current.source.threadId !== source!.threadId ||
                    current.source.workspaceRoot !== source!.workspaceRoot
                  )
                    return yield* new BoatError({ category: "conflict" });
                  yield* saveWork({ ...work, [action.requestId]: { ...current, sourceTree } });
                }),
              );
            }).pipe(
              Effect.ensuring(fs.remove(archive).pipe(Effect.orElseSucceed(() => undefined))),
            );
          }),
        () =>
          Effect.sync(() => {
            prepareInFlight.delete(action.requestId);
          }),
      );
    } else if (action.action === "exec") {
      if (agentThreadId)
        yield* updateInstance(action, (current) => ({
          leases: Array.from(new Set([...current.leases, agentThreadId])),
        }));
      const output = yield* api
        .request(token, `${sandboxPath}/commands`, "POST", {
          command: `mkdir -p /home/user/crew && cd /home/user/crew || exit
export PATH="$PWD/node_modules/.bin:$PATH"
${action.command}`,
          timeoutSeconds: 20,
        })
        .pipe(Effect.flatMap(decode(ProcessStatus)));
      if (output.processId !== undefined && output.exitCode === undefined) {
        const command = {
          processId: output.processId,
          threadId: agentThreadId ?? null,
          expiresAt: instance.expiresAt,
        };
        yield* workLock.withPermits(1)(
          Effect.gen(function* () {
            const current = work[action.requestId]!;
            yield* saveWork({
              ...work,
              [action.requestId]: {
                ...current,
                commands: [
                  ...current.commands.filter((item) => item.processId !== command.processId),
                  command,
                ],
              },
            });
          }),
        );
      }
      yield* updateInstance(action, {
        output: `${output.stdout ?? ""}\n${output.stderr ?? ""}`
          .replace(/(#token=)[^\s]+/g, "$1[private]")
          .slice(-12000),
      });
    } else if (action.action === "snapshot") {
      const name = `crew-${action.requestId}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 63);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (
            ledger.instances.some(
              (item) =>
                item.projectId === action.projectId && item.savedSnapshot?.status === "saving",
            )
          )
            return yield* new BoatError({ category: "conflict" });
          const { snapshot } = yield* api
            .request(token, "/saved-snapshots", "POST", {
              sandboxId: instance.sandboxId,
              name,
            })
            .pipe(Effect.flatMap(decode(SnapshotResponse)));
          if (snapshot.name !== name) return yield* new BoatError({ category: "provider" });
          yield* save({
            ...ledger,
            instances: ledger.instances.map((item) =>
              item.requestId === action.requestId && item.projectId === action.projectId
                ? { ...item, savedSnapshot: snapshot }
                : item,
            ),
            projects:
              snapshot.status === "ready"
                ? {
                    ...ledger.projects,
                    [action.projectId]: {
                      ...projectSettings(action.projectId),
                      snapshot: snapshot.name,
                    },
                  }
                : ledger.projects,
          });
        }),
      );
    } else if (action.action === "logs") {
      if (instance.processId === null) return yield* new BoatError({ category: "not_found" });
      const output = yield* api
        .request(token, `${sandboxPath}/commands/${instance.processId}`)
        .pipe(Effect.flatMap(decode(ProcessStatus)));
      yield* updateInstance(action, {
        output: `${output.stdout ?? ""}\n${output.stderr ?? ""}`
          .replace(/(#token=)[^\s]+/g, "$1[private]")
          .slice(-12000),
      });
    } else if (action.action === "cancel") {
      if (instance.processId !== null)
        yield* api.request(token, `${sandboxPath}/commands/${instance.processId}`, "DELETE");
      yield* updateInstance(action, { processId: null });
    } else if (action.action === "preview") {
      if (threadId && settings.webAccess !== "private") yield* updateInstance(action, { threadId });
      yield* attachPreview(
        { ...instance, threadId: threadId ?? instance.threadId },
        token,
        true,
        agentThreadId,
      );
    } else {
      if (action.action === "resume") {
        const fresh = yield* read(action.projectId);
        const now = yield* Clock.currentTimeMillis;
        let ownsResume = false;
        yield* Effect.gen(function* () {
          const operation = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const current = ledger.instances.find(
                (item) =>
                  item.requestId === action.requestId && item.projectId === action.projectId,
              )!;
              if (
                current.state === "deleted" ||
                current.state === "deleting" ||
                current.state === "stopping" ||
                current.state === "archiving"
              )
                return yield* new BoatError({ category: "conflict" });
              if (resumeInFlight.has(current.requestId)) return null;
              if (!current.resumeOperation) {
                if (!inactive.has(current.state)) return null;
                if (!fresh.account?.canStart) return yield* new BoatError({ category: "capacity" });
              }
              const ttlSeconds = current.resumeOperation?.ttlSeconds ?? ttlMinutes * 60;
              const expiresAt = Math.max(
                current.resumeOperation ? Date.parse(current.expiresAt) : 0,
                now + ttlSeconds * 1000,
              );
              const own = ledger.instances.filter((item) => item.projectId === action.projectId);
              const others = own.filter(
                (item) => item.requestId !== action.requestId && !inactive.has(item.state),
              );
              if (others.length >= settings.maxConcurrent)
                return yield* new BoatError({ category: "capacity" });
              const reservedCost = others.reduce(
                (sum, item) =>
                  sum +
                  (Math.max(0, Date.parse(item.expiresAt) - now) / 3600000) * rates[item.size],
                0,
              );
              if (
                reservedCost +
                  own.reduce((sum, item) => sum + item.costUsd, 0) +
                  ((expiresAt - now) / 3600000) * rates[current.size] >
                settings.budgetUsd
              )
                return yield* new BoatError({ category: "budget" });
              const resumeOperation = current.resumeOperation ?? {
                id: `${current.requestId}-resume-${current.revision + 1}`,
                ttlSeconds,
                previousState: current.state,
                previousExpiresAt: current.expiresAt,
                previousStoppedAt: current.stoppedAt,
              };
              yield* save({
                ...ledger,
                instances: ledger.instances.map((item) =>
                  item === current
                    ? {
                        ...item,
                        revision: item.revision + 1,
                        resumeOperation,
                        state: "provisioning",
                        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
                        ...(current.resumeOperation
                          ? {}
                          : { stoppedAt: null, processId: null, previewUrl: null }),
                      }
                    : item,
                ),
              });
              resumeInFlight.add(current.requestId);
              ownsResume = true;
              return resumeOperation;
            }),
          );
          if (operation) {
            yield* api
              .request(
                token,
                `${sandboxPath}/resume`,
                "POST",
                { ttlSeconds: operation.ttlSeconds },
                operation.id,
              )
              .pipe(
                Effect.catchTags({
                  BoatError: Effect.fn("BoatService.resumeFailed")(function* (error) {
                    if (
                      error.status !== undefined &&
                      error.status >= 400 &&
                      error.status < 500 &&
                      error.status !== 408 &&
                      error.status !== 409
                    ) {
                      const stoppedAt =
                        operation.previousStoppedAt ?? DateTime.formatIso(yield* DateTime.now);
                      yield* updateInstance(action, (current) =>
                        current.resumeOperation?.id === operation.id &&
                        current.state === "provisioning" &&
                        !current.deletionOperationId
                          ? {
                              state: operation.previousState,
                              expiresAt: operation.previousExpiresAt ?? current.expiresAt,
                              stoppedAt,
                              resumeOperation: null,
                            }
                          : {},
                      );
                    }
                    return yield* error;
                  }),
                }),
              );
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (ownsResume) resumeInFlight.delete(action.requestId);
            }),
          ),
        );
      } else {
        yield* api.request(token, `${sandboxPath}/${action.action}`, "POST", {});
        yield* updateInstance(action, {
          state: "stopping",
          processId: null,
          previewUrl: null,
          leases: [],
          resumeOperation: null,
        });
      }
    }

    if (["stop", "delete"].includes(action.action) && instance.threadId && instance.previewTabId) {
      yield* previews
        .close({ threadId: instance.threadId, tabId: PreviewTabId.make(instance.previewTabId) })
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* updateInstance(action, { previewTabId: null, processId: null });
    }
    if (["stop", "delete"].includes(action.action)) {
      yield* workLock.withPermits(1)(
        Effect.gen(function* () {
          const current = work[action.requestId];
          if (current && current.commands.length > 0)
            yield* saveWork({ ...work, [action.requestId]: { ...current, commands: [] } });
        }),
      );
    }
    if (action.action === "prepare" && settings.webAccess === "private")
      yield* attachPreview(instance, token, true, agentThreadId);
    const result = yield* read(
      action.action === "stop" || action.action === "delete" ? undefined : action.projectId,
    );
    return {
      ...result,
      instances: result.instances.filter((item) => item.projectId === action.projectId),
    };
  });
  const operate = (action: BoatAction, threadId?: ThreadId) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        if (transfersInFlight.has(action.requestId)) return false;
        operationsInFlight.set(
          action.requestId,
          (operationsInFlight.get(action.requestId) ?? 0) + 1,
        );
        return true;
      }),
      (acquired) =>
        acquired
          ? executeOperation(action, threadId)
          : Effect.fail(new BoatError({ category: "conflict" })),
      (acquired) =>
        Effect.sync(() => {
          if (!acquired) return;
          const remaining = (operationsInFlight.get(action.requestId) ?? 1) - 1;
          if (remaining) operationsInFlight.set(action.requestId, remaining);
          else operationsInFlight.delete(action.requestId);
        }),
    );

  const inspectTransfer = Effect.fn("BoatService.inspectTransfer")(function* (
    input: Extract<BoatTransferInput, { action: "inspect" }>,
  ) {
    const root = yield* project(input.projectId);
    const instance = ledger.instances.find(
      (item) =>
        item.requestId === input.requestId &&
        item.projectId === input.projectId &&
        item.sandboxId === input.sandboxId,
    );
    if (!instance || root.id !== input.projectId || !instance.threadId)
      return yield* new BoatError({ category: "not_found" });
    const previous = work[input.requestId];
    const now = yield* Clock.currentTimeMillis;
    if (
      !["archived", "stopped"].includes(instance.state) ||
      instance.leases.length > 0 ||
      instance.resumeOperation ||
      instance.deletionOperationId ||
      resumeInFlight.has(input.requestId) ||
      prepareInFlight.has(input.requestId) ||
      operationsInFlight.has(input.requestId) ||
      work[input.requestId]?.commands.some(
        (command) =>
          !Number.isFinite(Date.parse(command.expiresAt)) || Date.parse(command.expiresAt) > now,
      )
    )
      return yield* new BoatError({ category: "conflict" });
    const thread = yield* projections
      .getThreadShell(input.targetThreadId)
      .pipe(Effect.mapError(storageError));
    if (!thread || thread.deletedAt !== null || thread.projectId !== input.projectId)
      return yield* new BoatError({ category: "not_found" });
    const workspaceRoot = yield* fs
      .realPath(thread.worktreePath ?? root.workspaceRoot)
      .pipe(Effect.mapError(storageError));
    const head = yield* git
      .execute({
        operation: "boat-transfer",
        cwd: workspaceRoot,
        args: ["rev-parse", "--verify", "HEAD"],
      })
      .pipe(Effect.mapError(storageError));
    if (head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim()))
      return yield* new BoatError({ category: "conflict" });
    if (new Set(input.receiptPaths).size !== input.receiptPaths.length)
      return yield* new BoatError({ category: "conflict" });
    const files = [];
    let totalBytes = 0;
    for (const name of [...input.receiptPaths].sort()) {
      if (
        path.isAbsolute(name) ||
        name.split(/[\\/]/).some((part) => !part || part === ".." || part.startsWith("."))
      )
        return yield* new BoatError({ category: "conflict" });
      const file = yield* fs
        .realPath(path.join(workspaceRoot, name))
        .pipe(Effect.mapError(storageError));
      const relative = path.relative(workspaceRoot, file);
      if (
        relative.split(path.sep).some((part) => part.startsWith(".")) ||
        path.isAbsolute(relative)
      )
        return yield* new BoatError({ category: "conflict" });
      const stat = yield* fs.stat(file).pipe(Effect.mapError(storageError));
      totalBytes += Number(stat.size);
      if (stat.type !== "File" || stat.size > 2_097_152n || totalBytes > 16_777_216)
        return yield* new BoatError({ category: "conflict" });
      const content = yield* fs.readFile(file).pipe(Effect.mapError(storageError));
      if (content.length !== Number(stat.size) || content.length > 2_097_152)
        return yield* new BoatError({ category: "conflict" });
      const digest = yield* crypto.digest("SHA-256", content).pipe(Effect.mapError(storageError));
      files.push({
        path: name,
        sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      });
    }
    const latestThread = yield* projections
      .getThreadShell(input.targetThreadId)
      .pipe(Effect.mapError(storageError));
    const latestProject = yield* project(input.projectId);
    if (
      !latestThread ||
      latestThread.deletedAt !== null ||
      latestThread.projectId !== input.projectId
    )
      return yield* new BoatError({ category: "conflict" });
    const latestWorkspace = yield* fs
      .realPath(latestThread.worktreePath ?? latestProject.workspaceRoot)
      .pipe(Effect.mapError(storageError));
    if (latestWorkspace !== workspaceRoot) return yield* new BoatError({ category: "conflict" });
    const current = ledger.instances.find((item) => item.requestId === input.requestId);
    if (
      !current ||
      current.threadId !== instance.threadId ||
      current.sandboxId !== instance.sandboxId ||
      !["archived", "stopped"].includes(current.state) ||
      current.leases.length > 0 ||
      current.resumeOperation ||
      current.deletionOperationId ||
      work[input.requestId] !== previous
    )
      return yield* new BoatError({ category: "conflict" });
    return {
      projectId: input.projectId,
      requestId: input.requestId,
      sandboxId: input.sandboxId,
      expected: {
        revision: current.revision,
        ownerThreadId: current.threadId!,
        source: previous ? { ...previous.source, sourceTree: previous.sourceTree ?? null } : null,
      },
      target: { threadId: thread.id, workspaceRoot, head: head.stdout.trim(), files },
    } satisfies BoatTransferProposal;
  });

  const transfer = Effect.fn("BoatService.transfer")(function* (
    input: BoatTransferInput,
    session: AuthenticatedSession,
  ) {
    for (const scope of [AuthEnvironmentMaintainScope, AuthOrchestrationOperateScope]) {
      if (!session.scopes.includes(scope))
        return yield* new EnvironmentAuthorizationError({
          message: `The authenticated session is missing required scope: ${scope}.`,
          ...authScopeRequiredResponse(scope),
        });
    }
    const decoded = yield* decodeTransferInput(input).pipe(
      Effect.mapError(() => new BoatError({ category: "conflict" })),
    );
    if (decoded.action === "inspect")
      return { proposal: yield* inspectTransfer(decoded), committed: false };
    const expected = decoded.proposal;
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        if (transfersInFlight.has(expected.requestId) || operationsInFlight.has(expected.requestId))
          return false;
        transfersInFlight.add(expected.requestId);
        return true;
      }),
      (acquired) =>
        acquired
          ? Effect.gen(function* () {
              const inspection = {
                action: "inspect" as const,
                projectId: expected.projectId,
                requestId: expected.requestId,
                sandboxId: expected.sandboxId,
                targetThreadId: expected.target.threadId,
                receiptPaths: expected.target.files.map((file) => file.path),
              };
              const current = yield* inspectTransfer(inspection);
              if (encodeCacheKey(current) !== encodeCacheKey(expected))
                return yield* new BoatError({ category: "conflict" });
              yield* previewLock.withPermits(1)(
                workLock.withPermits(1)(
                  lock.withPermits(1)(
                    Effect.gen(function* () {
                      const checked = yield* inspectTransfer(inspection);
                      if (encodeCacheKey(checked) !== encodeCacheKey(expected))
                        return yield* new BoatError({ category: "conflict" });
                      const committedAt = DateTime.formatIso(yield* DateTime.now);
                      yield* Effect.uninterruptible(
                        Effect.gen(function* () {
                          yield* save({
                            ...ledger,
                            instances: ledger.instances.map((item) =>
                              item.requestId !== expected.requestId
                                ? item
                                : {
                                    ...item,
                                    threadId: expected.target.threadId,
                                    revision: item.revision + 1,
                                    sourceBinding: {
                                      revision: item.revision + 1,
                                      proposal: expected,
                                      sessionId: session.sessionId,
                                      committedAt,
                                    },
                                    leases: [],
                                    processId: null,
                                    previewTabId: null,
                                    previewUrl: null,
                                  },
                            ),
                          });
                          yield* saveWork(work).pipe(
                            Effect.catchTags({
                              BoatError: () =>
                                Effect.logWarning(
                                  "Boat transfer committed; derived source cache could not be saved.",
                                ),
                            }),
                          );
                          const desktop = privateDesktopPreviews.get(expected.requestId);
                          if (desktop) yield* Deferred.succeed(desktop.ended, undefined);
                        }),
                      );
                    }),
                  ),
                ),
              );
              for (const entry of [
                privatePreviews.get(expected.requestId),
                privateAndroidPreviews.get(expected.requestId),
                privateDesktopPreviews.get(expected.requestId),
              ])
                if (entry) yield* Scope.close(entry.scope, Exit.void);
              return { proposal: expected, committed: true };
            })
          : Effect.fail(new BoatError({ category: "conflict" })),
      (acquired) =>
        Effect.sync(() => {
          if (acquired) transfersInFlight.delete(expected.requestId);
        }),
    );
  });

  const activeLeaseOwners = Effect.fn("BoatService.activeLeaseOwners")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
    requestId: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const desktop = privateDesktopPreviews.get(requestId);
    const desktopBinding = desktop?.access?.binding;
    const viewerActive =
      desktop !== undefined &&
      desktopBinding?.projectId === projectId &&
      work[requestId]?.sourceTree === desktopBinding.sourceTree &&
      [...desktop.viewers.values()].some((viewer) => viewer.activeUntil > now);
    const pending = [threadId];
    const visited = new Set<ThreadId>();
    const active = new Set<ThreadId>();
    while (pending.length > 0 && visited.size < 64) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const thread = yield* projections.getThreadShell(id);
      if (!thread || thread.projectId !== projectId || thread.deletedAt !== null) continue;
      if (
        (viewerActive && desktopBinding?.threadId === id) ||
        thread.activeRunId !== null ||
        thread.activityRunStatus != null ||
        backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
      )
        active.add(id);
      const { subagents } = yield* projections.getThreadRecords(id, ["subagents"]);
      for (const task of subagents) {
        if (task.threadId !== id) continue;
        if (isOrchestrationV2WorkActive(task.status) && !task.childThreadId) active.add(id);
        if (task.childThreadId && !visited.has(task.childThreadId))
          pending.push(task.childThreadId);
      }
    }
    // Larger trees retain their lease only until the same hard VM deadline.
    if (pending.length > 0) active.add(threadId);
    return active;
  }, Effect.mapError(storageError));
  const assertActiveLease: BoatService["Service"]["assertActiveLease"] = Effect.fn(
    "BoatService.assertActiveLease",
  )(function* (target, callerThreadId) {
    const changes = yield* PubSub.subscribe(leaseChanges);
    const generation = leaseGeneration;
    const ended = yield* Deferred.make<void>();
    const validate = Effect.gen(function* () {
      yield* key;
      const caller = yield* projections
        .getThreadShell(callerThreadId)
        .pipe(Effect.mapError(storageError));
      if (!caller || caller.deletedAt !== null)
        return yield* new BoatError({ category: "not_found" });
      const instance = ledger.instances.find(
        (item) =>
          item.requestId === target.requestId &&
          item.projectId === caller.projectId &&
          item.sandboxId === target.sandboxId,
      );
      const source = work[target.requestId]?.source;
      if (
        !instance ||
        !source?.threadId ||
        source.projectId !== caller.projectId ||
        !["ready", "idle", "running"].includes(instance.state) ||
        !instance.leases.includes(callerThreadId) ||
        !projectSettings(caller.projectId).enabled ||
        generation !== leaseGeneration
      )
        return yield* new BoatError({ category: "conflict" });
      yield* project(caller.projectId);
      const now = yield* Clock.currentTimeMillis;
      if (!Number.isFinite(Date.parse(instance.expiresAt)) || Date.parse(instance.expiresAt) <= now)
        return yield* new BoatError({ category: "conflict" });
      const owners = yield* activeLeaseOwners(source.threadId, caller.projectId, target.requestId);
      if (!owners.has(callerThreadId)) return yield* new BoatError({ category: "conflict" });
      const latest = ledger.instances.find((item) => item.requestId === target.requestId);
      if (
        latest?.sandboxId !== target.sandboxId ||
        latest.projectId !== caller.projectId ||
        !["ready", "idle", "running"].includes(latest.state) ||
        !latest.leases.includes(callerThreadId) ||
        generation !== leaseGeneration ||
        Date.parse(latest.expiresAt) <= (yield* Clock.currentTimeMillis)
      )
        return yield* new BoatError({ category: "conflict" });
      return instance;
    });
    const instance = yield* validate;
    const sourceTree = work[target.requestId]?.sourceTree ?? null;
    const bindingRevision = work[target.requestId]?.bindingRevision;
    const deadline = Date.parse(instance.expiresAt);
    const check = Effect.gen(function* () {
      if (
        (yield* Deferred.isDone(ended)) ||
        (yield* Clock.currentTimeMillis) >= deadline ||
        (work[target.requestId]?.sourceTree ?? null) !== sourceTree ||
        work[target.requestId]?.bindingRevision !== bindingRevision
      )
        return yield* new BoatError({ category: "conflict" });
      yield* validate;
    }).pipe(Effect.tapError(() => Deferred.succeed(ended, undefined)));
    const revoke = Deferred.succeed(ended, undefined);
    const source = work[target.requestId]?.source;
    yield* Effect.addFinalizer(() => revoke);
    yield* Effect.forever(
      Effect.gen(function* () {
        const changed = yield* PubSub.take(changes);
        const next = changed.ledger.instances.find((item) => item.requestId === target.requestId);
        const nextSource = changed.work[target.requestId]?.source;
        if (
          changed.generation !== generation ||
          next?.sandboxId !== target.sandboxId ||
          next.projectId !== instance.projectId ||
          !["ready", "idle", "running"].includes(next.state) ||
          !next.leases.includes(callerThreadId) ||
          !changed.ledger.projects[instance.projectId]?.enabled ||
          nextSource?.threadId !== source?.threadId ||
          nextSource?.workspaceRoot !== source?.workspaceRoot ||
          (changed.work[target.requestId]?.sourceTree ?? null) !== sourceTree ||
          changed.work[target.requestId]?.bindingRevision !== bindingRevision
        )
          return yield* new BoatError({ category: "conflict" });
        yield* check;
      }),
    ).pipe(
      Effect.catch(() => revoke),
      Effect.forkScoped,
    );
    yield* Effect.sleep(Math.max(0, deadline - (yield* Clock.currentTimeMillis))).pipe(
      Effect.andThen(revoke),
      Effect.forkScoped,
    );
    return {
      projectId: instance.projectId,
      threadId: callerThreadId,
      requestId: target.requestId,
      sandboxId: target.sandboxId,
      expiresAt: instance.expiresAt,
      sourceTree,
      check,
      revoked: Deferred.await(ended),
    };
  });
  const reconcileInstance = Effect.fn("BoatService.reconcileInstance")(function* (
    item: StoredInstance,
    now: number,
  ) {
    if (!item.sandboxId || item.state === "deleted" || item.state === "deleting") return;
    const settings = projectSettings(item.projectId);
    if (["archived", "stopped"].includes(item.state)) {
      if (item.stoppedAt && now - Date.parse(item.stoppedAt) >= settings.retentionDays * 86400000)
        yield* operate({
          action: "delete",
          projectId: item.projectId,
          requestId: item.requestId,
        });
      return;
    }
    if (inactive.has(item.state) || item.resumeOperation) return;
    const spent = ledger.instances
      .filter((entry) => entry.projectId === item.projectId)
      .reduce((sum, entry) => sum + entry.costUsd, 0);
    if (Date.parse(item.expiresAt) <= now || spent >= settings.budgetUsd) {
      yield* operate({ action: "stop", projectId: item.projectId, requestId: item.requestId });
      return;
    }
    const threadId = work[item.requestId]?.source.threadId ?? item.threadId;
    if (threadId && Date.parse(item.expiresAt) - now <= 5 * 60_000)
      yield* PubSub.publish(expiryWarnings, {
        projectId: item.projectId,
        threadId,
        requestId: item.requestId,
        sandboxId: item.sandboxId,
        expiresAt: item.expiresAt,
      });
    const commands = work[item.requestId]?.commands ?? [];
    if (item.leases.length === 0 && commands.length === 0) return;
    const token = yield* key;
    const finishedCommands = new Set<number>();
    for (const command of commands) {
      if (Date.parse(command.expiresAt) <= now) {
        finishedCommands.add(command.processId);
        continue;
      }
      const status = yield* api
        .request(
          token,
          `/sandboxes/${encodeURIComponent(item.sandboxId)}/commands/${command.processId}`,
        )
        .pipe(
          Effect.flatMap(decode(ProcessStatus)),
          Effect.catchTags({
            BoatError: (error) => Effect.succeed(error.status === 404 ? { exitCode: -1 } : null),
          }),
        );
      if (status?.exitCode !== undefined) finishedCommands.add(command.processId);
    }
    const liveCommands = commands.filter((command) => !finishedCommands.has(command.processId));
    if (finishedCommands.size > 0)
      yield* workLock.withPermits(1)(
        Effect.gen(function* () {
          const current = work[item.requestId]!;
          yield* saveWork({
            ...work,
            [item.requestId]: {
              ...current,
              commands: current.commands.filter(
                (command) => !finishedCommands.has(command.processId),
              ),
            },
          });
        }),
      );
    const liveOwners = new Set(
      liveCommands.flatMap((command) => (command.threadId ? [command.threadId] : [])),
    );
    const sourceOwner = work[item.requestId]?.source.threadId ?? item.threadId;
    const roots = new Set([...item.leases, ...(sourceOwner ? [sourceOwner] : [])]);
    for (const threadId of roots) {
      for (const active of yield* activeLeaseOwners(threadId, item.projectId, item.requestId))
        liveOwners.add(active);
    }
    const finishedOwners = new Set(item.leases.filter((threadId) => !liveOwners.has(threadId)));
    const newOwners = [...liveOwners].filter((threadId) => !item.leases.includes(threadId));
    const current =
      finishedOwners.size > 0 || newOwners.length > 0
        ? yield* updateInstance(item, (latest) => ({
            leases: [
              ...new Set([
                ...latest.leases.filter(
                  (threadId) =>
                    !finishedOwners.has(threadId) ||
                    work[item.requestId]?.commands.some((command) => command.threadId === threadId),
                ),
                ...newOwners,
              ]),
            ],
          }))
        : item;
    if (current.leases.length === 0 && (work[item.requestId]?.commands.length ?? 0) === 0)
      yield* operate({ action: "stop", projectId: item.projectId, requestId: item.requestId });
  });
  const reconcile = Effect.fn("BoatService.reconcile")(function* () {
    const owned = ledger.instances.filter(
      (item) => item.sandboxId && item.state !== "deleted" && item.state !== "error",
    );
    if (
      owned.length === 0 &&
      !ledger.instances.some((item) => item.savedSnapshot?.status === "saving")
    )
      return;
    yield* read().pipe(
      Effect.catchTags({
        BoatError: (error) =>
          Effect.logWarning("Boat status refresh failed; retaining recorded deadlines", {
            category: error.category,
          }),
      }),
    );
    const now = yield* Clock.currentTimeMillis;
    for (const item of ledger.instances)
      yield* reconcileInstance(item, now).pipe(
        Effect.catchTags({
          BoatError: (error) =>
            Effect.logWarning("Boat lifecycle action failed; retrying on the next pass", {
              requestId: item.requestId,
              category: error.category,
            }),
        }),
      );
  });
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* reconcile().pipe(Effect.orElseSucceed(() => undefined));
      yield* Effect.sleep("10 seconds");
    }),
  ).pipe(Effect.forkScoped);
  return {
    expiring: Stream.fromPubSub(expiryWarnings),
    read,
    assertActiveLease,
    openDesktopAccess,
    getDesktopAccess,
    registerDesktopViewer,
    transfer,
    isEnabled: (projectId: ProjectId) => Effect.sync(() => projectSettings(projectId).enabled),
    connect,
    disconnect,
    configure,
    configureDefaults,
    operate,
    reconcile,
  };
});

export const layer = Layer.effect(BoatService, make);
