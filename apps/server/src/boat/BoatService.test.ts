import { assert, it } from "@effect/vitest";
import {
  DEFAULT_BOAT_PROJECT,
  AuthSessionId,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  type DeviceError,
  type DeviceOpenInput,
  type DeviceSession,
  BoatInstance,
  BoatError,
  ProjectId,
  PreviewTabId,
  ThreadId,
  RunId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { BoatApi } from "./BoatApi.ts";
import * as BoatSshTunnel from "./BoatSshTunnel.ts";
import { make, sourceSyncScript } from "./BoatService.ts";
import { boatUsageWindows, estimateBoatThreadUsage } from "./boatAnalytics.ts";

const decodeInstance = Schema.decodeUnknownEffect(BoatInstance);
const decodeStoredInstances = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ instances: Schema.Array(BoatInstance) })),
);
const projectId = ProjectId.make("project-boat");
const ownerThreadId = ThreadId.make("thread-boat");
function setup(
  onCall: (
    path: string,
    method: string,
    body?: unknown,
    idempotencyKey?: string,
  ) => Effect.Effect<unknown, BoatError> = () => Effect.void,
  threadId = ownerThreadId,
  onDeviceOpen: () => Effect.Effect<void, DeviceError> = () => Effect.void,
  onForwardClose: () => Effect.Effect<void> = () => Effect.void,
) {
  const calls: string[] = [];
  const privateForwards: string[][] = [];
  const closedPreviews: string[] = [];
  const openedPreviews: string[] = [];
  const previewTabs = new Map<string, { tabId: string }>();
  const deviceSessions: DeviceSession[] = [];
  const deviceOpens: Array<{
    input: DeviceOpenInput;
    workspaceRoot: string | undefined;
    hostname: string;
  }> = [];
  const deviceReleased = Deferred.makeUnsafe<void>();
  let deviceReleaseCount = 0;
  const forwardClosed = Deferred.makeUnsafe<void>();
  let closedForwards = 0;
  let machineState = "ready";
  let canStart = true;
  let costUsd = 0.01;
  let snapshotStatus = "saving";
  let workspaceRoot = process.cwd();
  let ownerActive = true;
  let projectExists = true;
  let archiveBytes = new Uint8Array();
  let sourceTree = "a".repeat(40);
  const threads = new Map<ThreadId, Partial<OrchestrationV2ThreadShell>>();
  const subagents = new Map<ThreadId, OrchestrationV2Subagent[]>();
  const gitCwds: string[] = [];
  let onGitRead = () => {};
  let commandResult: { processId: number; exitCode?: number | null } = {
    processId: 123,
    exitCode: 0,
  };
  let commandStatus: unknown = {};
  const api = Layer.succeed(BoatApi, {
    request: (_key, path, method = "GET", body, idempotencyKey) =>
      Effect.sync(() => {
        calls.push(`${method} ${path}`);
        if (path === "/limits")
          return {
            canStart,
            startBlockedReason: null,
            billingStatus: "active",
            maxActiveSandboxes: 2,
            planIncluded: { vmHoursRemaining: 500 },
            wallet: { balanceDollars: 0 },
            trialComputeCapSeconds: null,
            trialComputeUsedSeconds: null,
            machineTypes: [{ type: "default", available: true }],
          };
        if (path === "/saved-snapshots" || path.startsWith("/saved-snapshots/"))
          return { snapshot: { name: "crew-first", status: snapshotStatus } };
        if (path.endsWith("/commands")) {
          return commandResult;
        }
        if (/\/commands\/\d+$/.test(path)) return commandStatus;
        if (path.endsWith("/host")) return { url: "https://preview.example.test/web" };
        if (path.endsWith("/sshkey"))
          return {
            sshUser: "user",
            machineIp: "192.0.2.1",
            hostKey: "ssh-ed25519 Zml4dHVyZQ==",
          };
        if (path.endsWith("/desktop?vnc=1"))
          return { desktopUrl: "https://preview.example.test/android" };
        if (path.includes("/usage")) {
          const query = new URL(path, "https://boat.test").searchParams;
          return query.has("until")
            ? {
                sandboxId: path.split("/")[2],
                sandboxType: "default",
                billingMultiplier: 1,
                since: query.get("since"),
                until: query.get("until"),
                seconds: 3600,
                dollars: costUsd,
                secondsPerDollar: 360000,
                running: machineState !== "archived",
              }
            : { dollars: costUsd };
        }
        if (method === "DELETE" || path.startsWith("/deletion-operations/"))
          return { operation: { id: "delete-test", status: "completed" } };
        if (path.endsWith("/stop")) machineState = "archived";
        if (path.endsWith("/resume")) machineState = "ready";
        return { sandbox: { id: "bx_23456789", state: machineState } };
      }).pipe(Effect.tap(() => onCall(path, method, body, idempotencyKey))),
  });
  const base = ServerConfig.layerTest(process.cwd(), { prefix: "boat-service-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const services = Layer.mergeAll(
    api,
    Layer.mock(DeviceService)({
      state: Effect.sync(() => ({ sessions: [...deviceSessions] }) as never),
      openScopedSsh: (input, binding, context) =>
        Effect.gen(function* () {
          yield* binding.check;
          deviceOpens.push({
            input,
            workspaceRoot: context?.workspaceRoot,
            hostname: binding.hostname,
          });
          let released = false;
          const session = {
            ...input,
            deviceId: "canonical-android",
            openedAt: "2026-11-01T12:00:00.000Z",
          } as DeviceSession;
          const release = Effect.sync(() => {
            if (released) return;
            released = true;
            deviceReleaseCount++;
            const index = deviceSessions.indexOf(session);
            if (index !== -1) deviceSessions.splice(index, 1);
          }).pipe(Effect.andThen(Deferred.succeed(deviceReleased, undefined)), Effect.asVoid);
          yield* Effect.addFinalizer(() => release);
          yield* onDeviceOpen();
          yield* binding.check;
          deviceSessions.push(session);
          return { session, release };
        }),
    }),
    Layer.mock(Net.NetService)({ reserveLoopbackPort: () => Effect.succeed(39123) }),
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
            const forwarding = command.args.includes("-L");
            if (forwarding) {
              privateForwards.push([...command.args]);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closedForwards++;
                }).pipe(
                  Effect.andThen(Effect.suspend(onForwardClose)),
                  Effect.andThen(Deferred.succeed(forwardClosed, undefined)),
                ),
              );
            } else {
              const identity = command.args[command.args.indexOf("-f") + 1]!;
              yield* fs.writeFileString(`${identity}.pub`, "ssh-ed25519 Zml4dHVyZQ==");
            }
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: forwarding ? Stream.make(new TextEncoder().encode("READY\n")) : Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: forwarding ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(forwarding),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }).pipe(Effect.orDie),
        );
      }),
    ),
    Layer.mock(PreviewManager)({
      list: (input) =>
        Effect.succeed({
          sessions: previewTabs.has(input.threadId) ? [previewTabs.get(input.threadId)!] : [],
        } as never),
      open: (input) =>
        Effect.sync(() => {
          if (input.url) openedPreviews.push(input.url);
          previewTabs.set(input.threadId, { tabId: "setup-preview" });
          return { tabId: "setup-preview" } as never;
        }),
      close: (input) =>
        Effect.sync(() => {
          if (input.tabId) closedPreviews.push(input.tabId);
          previewTabs.delete(input.threadId);
        }),
      requestReveal: () => Effect.void,
    }),
    Layer.mock(ProjectionStoreV2)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === threadId || threads.has(id)
            ? {
                ...liveThreadShell(id),
                projectId,
                activeRunId: id === threadId && ownerActive ? RunId.make("run-boat") : null,
                activityRunStatus: null,
                ...threads.get(id),
              }
            : null,
        ),
      getThreadRecords: (id) => Effect.succeed({ subagents: subagents.get(id) ?? [] } as never),
    }),
    Layer.mock(Projects.ProjectService)({
      getShell: () =>
        Effect.succeed(
          projectExists
            ? Option.some({
                id: projectId,
                title: "Project",
                workspaceRoot,
              } as never)
            : Option.none(),
        ),
    }),
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return Layer.mock(Git.GitVcsDriver)({
          execute: ({ args, cwd }) =>
            Effect.gen(function* () {
              gitCwds.push(cwd);
              onGitRead();
              if (args[0] === "archive") {
                yield* fs.writeFile(args[args.indexOf("--output") + 1]!, archiveBytes);
              }
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: ["write-tree", "rev-parse"].includes(args[0]!) ? sourceTree : "tree",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }).pipe(Effect.orDie),
        });
      }),
    ),
    Secrets.layer.pipe(Layer.provide(base)),
  ).pipe(Layer.provideMerge(base));
  return {
    calls,
    privateForwards,
    closedPreviews,
    openedPreviews,
    deviceOpens,
    deviceSessions,
    deviceReleased: Deferred.await(deviceReleased),
    deviceReleaseCount: () => deviceReleaseCount,
    closedForwardCount: () => closedForwards,
    forwardClosed: Deferred.await(forwardClosed),
    gitCwds,
    setOnGitRead: (callback: () => void) => {
      onGitRead = callback;
    },
    services,
    setThread: (id: ThreadId, thread: Partial<OrchestrationV2ThreadShell>) => {
      threads.set(id, thread);
    },
    setSubagents: (id: ThreadId, tasks: OrchestrationV2Subagent[]) => {
      subagents.set(id, tasks);
    },
    setCommandResult: (result: typeof commandResult) => {
      commandResult = result;
    },
    setCommandStatus: (status: typeof commandStatus) => {
      commandStatus = status;
    },
    setCost: (cost: number) => {
      costUsd = cost;
    },
    setMachineState: (value: string) => {
      machineState = value;
    },
    setCanStart: (value: boolean) => {
      canStart = value;
    },
    setSnapshotStatus: (status: string) => {
      snapshotStatus = status;
    },
    setArchive: (bytes: Uint8Array) => {
      archiveBytes = new Uint8Array(bytes);
    },
    setSourceTree: (tree: string) => {
      sourceTree = tree;
    },
    removeProject: () => {
      projectExists = false;
    },
    setOwnerActive: (active: boolean) => {
      ownerActive = active;
    },
    setProjectRoot: (root: string) => {
      workspaceRoot = root;
    },
  };
}

it("uses UTC periods across year, month and daylight-saving boundaries", () => {
  for (const [range, now, since] of [
    ["day", "2026-10-25T01:30:00Z", "2026-10-25T00:00:00.000Z"],
    ["week", "2027-01-01T12:00:00Z", "2026-12-26T00:00:00.000Z"],
    ["month", "2026-03-31T23:59:00Z", "2026-03-01T00:00:00.000Z"],
  ] as const) {
    const period = boatUsageWindows(range, Date.parse(now));
    assert.equal(period.since, since);
    assert.isAtMost(period.windows.length, 8);
    assert.equal(period.windows.at(-1)?.until, period.until);
  }
});

it("leaves unrecorded thread history unassigned and preserves saved measurement freshness", () => {
  const point = {
    since: "2026-11-01T00:00:00Z",
    until: "2026-11-01T04:00:00Z",
    measuredUntil: "2026-11-01T04:00:00Z",
    recordedAt: "2026-11-01T05:00:00Z",
    seconds: 14400,
    dollars: 0.04,
    status: "stale" as const,
  };
  const unknown = estimateBoatThreadUsage(point, [], point.since, ownerThreadId);
  assert.equal(unknown.dollars, null);
  assert.equal(unknown.attribution, "unknown");
  const partial = estimateBoatThreadUsage(
    point,
    [
      {
        at: "2026-11-01T02:00:00Z",
        threadIds: [ownerThreadId],
        running: true,
      },
    ],
    point.since,
    ownerThreadId,
  );
  assert.closeTo(partial.dollars!, 0.02, 0.000001);
  assert.equal(partial.attribution, "unknown");
  assert.equal(partial.status, "stale");
});

it.effect("binds access to the caller's project, sandbox and authoritative lease", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    yield* boat.operate({ action: "start", projectId, requestId: "lease" }, ownerThreadId);
    const target = { requestId: "lease", sandboxId: "bx_23456789" };
    const access = yield* boat.assertActiveLease(target, ownerThreadId);
    assert.equal(access.projectId, projectId);
    yield* access.check;
    const foreign = ThreadId.make("foreign-project");
    const unleased = ThreadId.make("unleased-agent");
    const forged = ThreadId.make("unregistered-child");
    test.setThread(foreign, { projectId: ProjectId.make("other-project") });
    test.setThread(unleased, { activeRunId: RunId.make("unleased-run") });
    test.setThread(forged, {
      activeRunId: RunId.make("forged-run"),
      lineage: {
        parentThreadId: ownerThreadId,
        relationshipToParent: "subagent",
        rootThreadId: ownerThreadId,
      },
    });
    yield* boat.operate({ action: "exec", projectId, requestId: "lease", command: "true" }, forged);
    for (const [candidate, caller] of [
      [target, foreign],
      [target, unleased],
      [target, forged],
      [{ ...target, requestId: "other-request" }, ownerThreadId],
      [{ ...target, sandboxId: "bx_other_vm" }, ownerThreadId],
    ] as const) {
      assert.isTrue(
        Exit.isFailure(yield* boat.assertActiveLease(candidate, caller).pipe(Effect.exit)),
      );
    }
    test.setSubagents(ownerThreadId, [
      {
        threadId: ownerThreadId,
        childThreadId: forged,
        status: "running",
      } as OrchestrationV2Subagent,
    ]);
    const childAccess = yield* boat.assertActiveLease(target, forged);
    yield* childAccess.check;
    test.setThread(forged, { activeRunId: null });
    yield* boat.reconcile();
    yield* childAccess.revoked;
    assert.isTrue(Exit.isFailure(yield* childAccess.check.pipe(Effect.exit)));
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("never extends an issued access deadline when the VM is renewed", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      inheritDefaults: false,
      ttlMinutes: 1,
    });
    yield* boat.operate({ action: "start", projectId, requestId: "expiring" }, ownerThreadId);
    const target = { requestId: "expiring", sandboxId: "bx_23456789" };
    const access = yield* boat.assertActiveLease(target, ownerThreadId);
    yield* TestClock.adjust("30 seconds");
    yield* boat.operate({ action: "renew", projectId, requestId: "expiring" }, ownerThreadId);
    yield* TestClock.adjust("30 seconds");
    yield* access.revoked;
    assert.isTrue(Exit.isFailure(yield* access.check.pipe(Effect.exit)));
    const fresh = yield* boat.assertActiveLease(target, ownerThreadId);
    yield* fresh.check;
    yield* boat.operate({ action: "stop", projectId, requestId: "expiring" });
    yield* fresh.revoked;
    yield* boat.disconnect;
    assert.isTrue(
      Exit.isFailure(yield* boat.assertActiveLease(target, ownerThreadId).pipe(Effect.exit)),
    );
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect.each(["stop", "delete", "lease removed"] as const)(
  "opens private web access only through SSH and closes it on %s",
  (end) => {
    const test = setup();
    return Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        webAccess: "private",
        devCommand: "npm run dev",
      });
      yield* boat.operate({ action: "start", projectId, requestId: "private-web" }, ownerThreadId);
      yield* boat.operate(
        { action: "prepare", projectId, requestId: "private-web" },
        ownerThreadId,
      );
      assert.lengthOf(test.privateForwards, 1);
      const args = test.privateForwards[0]!;
      assert.include(args, "127.0.0.1:39123:127.0.0.1:3000");
      assert.include(args, "StrictHostKeyChecking=yes");
      assert.include(args, "ForwardAgent=no");
      assert.notInclude(args, "-R");
      assert.deepEqual(test.openedPreviews, ["http://127.0.0.1:39123/"]);
      const state = yield* boat.read(projectId);
      assert.equal(state.instances[0]?.previewUrl, null);
      assert.isTrue(test.calls.every((call) => !call.includes("/host")));
      if (end === "stop") {
        const stranger = ThreadId.make("unregistered-preview-child");
        test.setThread(stranger, {
          activeRunId: RunId.make("stranger-run"),
          lineage: {
            parentThreadId: ownerThreadId,
            relationshipToParent: "subagent",
            rootThreadId: ownerThreadId,
          },
        });
        assert.isTrue(
          Exit.isFailure(
            yield* boat
              .operate(
                {
                  action: "preview",
                  projectId,
                  requestId: "private-web",
                  threadId: stranger,
                },
                stranger,
              )
              .pipe(Effect.exit),
          ),
        );
        assert.equal(test.closedForwardCount(), 0);
        assert.lengthOf(test.closedPreviews, 0);
        assert.equal((yield* boat.read(projectId)).instances[0]?.threadId, ownerThreadId);
      }
      if (end === "lease removed") {
        test.setOwnerActive(false);
        yield* boat.reconcile();
      } else {
        yield* boat.operate({ action: end, projectId, requestId: "private-web" });
      }
      yield* test.forwardClosed;
      assert.equal(test.closedForwardCount(), 1);
      assert.include(test.closedPreviews, "setup-preview");
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect("retains only a successfully prepared source tree for desktop access", () => {
  let failSync = false;
  const test = setup((path, _method, body) =>
    failSync && path.endsWith("/commands") && JSON.stringify(body).includes("source-files.json")
      ? Effect.fail(new BoatError({ category: "provider" }))
      : Effect.void,
  );
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    const target = { requestId: "desktop-tree", sandboxId: "bx_23456789" };
    yield* boat.operate({ action: "start", projectId, requestId: target.requestId }, ownerThreadId);
    assert.isNull((yield* boat.assertActiveLease(target, ownerThreadId)).sourceTree);
    yield* boat.operate(
      { action: "prepare", projectId, requestId: target.requestId },
      ownerThreadId,
    );
    assert.equal((yield* boat.assertActiveLease(target, ownerThreadId)).sourceTree, "a".repeat(40));
    const reopened = yield* make;
    assert.equal(
      (yield* reopened.assertActiveLease(target, ownerThreadId)).sourceTree,
      "a".repeat(40),
    );
    test.setSourceTree("b".repeat(40));
    failSync = true;
    assert.isTrue(
      Exit.isFailure(
        yield* boat
          .operate({ action: "prepare", projectId, requestId: target.requestId }, ownerThreadId)
          .pipe(Effect.exit),
      ),
    );
    assert.isNull((yield* boat.assertActiveLease(target, ownerThreadId)).sourceTree);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("rejects overlapping source prepares instead of certifying an ambiguous tree", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    let syncs = 0;
    const test = setup((path, _method, body) =>
      path.endsWith("/commands") && JSON.stringify(body).includes("source-files.json")
        ? Effect.gen(function* () {
            syncs++;
            yield* Deferred.succeed(syncs === 1 ? entered : secondEntered, undefined);
            yield* Deferred.await(release);
          })
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      const target = { action: "prepare", projectId, requestId: "overlap-tree" } as const;
      yield* boat.operate({ ...target, action: "start" }, ownerThreadId);
      const first = yield* boat.operate(target, ownerThreadId).pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(entered), Fiber.join(first));
      const second = yield* boat.operate(target, ownerThreadId).pipe(Effect.exit, Effect.forkChild);
      const secondResult = yield* Effect.raceFirst(
        Fiber.join(second),
        Deferred.await(secondEntered).pipe(Effect.as(Exit.succeed(undefined))),
      );
      yield* Effect.sync(() => {
        assert.isTrue(Exit.isFailure(secondResult));
        assert.equal(syncs, 1);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(first);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }),
);

it.effect("shares one authorized SSH identity across private forwards", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    const target = { requestId: "desktop-forward", sandboxId: "bx_23456789" };
    yield* boat.operate({ action: "start", projectId, requestId: target.requestId }, ownerThreadId);
    const lease = yield* boat.assertActiveLease(target, ownerThreadId);
    const tunnels = yield* BoatSshTunnel.make;
    const binding = yield* tunnels.authorize(lease, Redacted.make("boat_fixture_private"));
    yield* tunnels.openAuthorized(binding, 6080);
    yield* tunnels.openAuthorized(binding, 6081);
    assert.equal(test.calls.filter((call) => call.endsWith("/sshkey")).length, 1);
    assert.lengthOf(test.privateForwards, 2);
    for (const forward of test.privateForwards) {
      assert.equal(forward[forward.indexOf("-i") + 1], binding.identityFile);
      assert.include(forward, `UserKnownHostsFile=${binding.knownHostsFile}`);
    }
    test.setOwnerActive(false);
    yield* boat.reconcile();
    assert.isTrue(Exit.isFailure(yield* tunnels.openAuthorized(binding, 6082).pipe(Effect.exit)));
    assert.lengthOf(test.privateForwards, 2);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

const desktopDescriptor = {
  viewer: { remotePort: 6080, path: "/vnc.html" },
  actor: {
    commandPath: "/home/user/.local/bin/weasel-computer-use",
    sha256: "c".repeat(64),
    expectedServerName: "weasel-computer-use",
    protocolRevision: 2,
  },
} as const;

it.effect("keeps borrowed desktop access alive until its source generation is replaced", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      webAccess: "private",
      devCommand: "npm run dev",
    });
    const target = { requestId: "desktop-session", sandboxId: "bx_23456789" };
    yield* boat.operate({ action: "start", projectId, requestId: target.requestId }, ownerThreadId);
    assert.isTrue(
      Exit.isFailure(
        yield* boat.openDesktopAccess(target, ownerThreadId, desktopDescriptor).pipe(Effect.exit),
      ),
    );
    yield* boat.operate(
      { action: "prepare", projectId, requestId: target.requestId },
      ownerThreadId,
    );
    const access = yield* boat.openDesktopAccess(target, ownerThreadId, desktopDescriptor);
    const calls = test.calls.length;
    const borrowed = yield* boat
      .getDesktopAccess(access.binding, ownerThreadId)
      .pipe(Effect.scoped);
    assert.strictEqual(borrowed, access);
    assert.isTrue(
      Exit.isFailure(
        yield* boat.getDesktopAccess({ ...access.binding }, ownerThreadId).pipe(Effect.exit),
      ),
    );
    assert.strictEqual(
      yield* boat.openDesktopAccess(target, ownerThreadId, desktopDescriptor),
      access,
    );
    assert.equal(test.calls.length, calls);
    assert.equal(access.binding.sourceTree, "a".repeat(40));
    assert.equal(access.viewer.tabId, "setup-preview");
    yield* access.lease.check;
    test.setSourceTree("b".repeat(40));
    yield* boat.operate(
      { action: "prepare", projectId, requestId: target.requestId },
      ownerThreadId,
    );
    yield* access.lease.revoked;
    assert.isTrue(Exit.isFailure(yield* access.lease.check.pipe(Effect.exit)));
    assert.isTrue(
      Exit.isFailure(yield* boat.getDesktopAccess(access.binding, ownerThreadId).pipe(Effect.exit)),
    );
    const next = yield* boat.openDesktopAccess(target, ownerThreadId, desktopDescriptor);
    assert.equal(next.binding.sourceTree, "b".repeat(40));
    assert.notEqual(next.binding.leaseGeneration, access.binding.leaseGeneration);
    test.setOwnerActive(false);
    yield* boat.reconcile();
    yield* next.lease.revoked;
    assert.isTrue(
      Exit.isFailure(yield* boat.getDesktopAccess(access.binding, ownerThreadId).pipe(Effect.exit)),
    );
    assert.isTrue(
      test.calls.every((call) => !call.includes("/desktop") && !call.includes("/host")),
    );
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect(
  "keeps explicit desktop control alive after its agent finishes until input expires",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configureDefaults({ ttlMinutes: 3, retentionDays: 14 });
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        webAccess: "private",
      });
      const target = { requestId: "desktop-human", sandboxId: "bx_23456789" };
      yield* boat.operate(
        { action: "start", projectId, requestId: target.requestId },
        ownerThreadId,
      );
      yield* boat.operate(
        { action: "prepare", projectId, requestId: target.requestId },
        ownerThreadId,
      );
      const access = yield* boat.openDesktopAccess(target, ownerThreadId, desktopDescriptor);
      const viewer = yield* boat.registerDesktopViewer(access.binding, ownerThreadId, {
        tabId: access.viewer.tabId,
        viewerId: "viewer-human",
      });
      yield* viewer.activate;
      test.setOwnerActive(false);
      yield* boat.reconcile();
      yield* access.lease.check;
      assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
      yield* TestClock.adjust("50 seconds");
      yield* viewer.touch;
      yield* TestClock.adjust("59 seconds");
      yield* boat.reconcile();
      assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
      yield* TestClock.adjust("1 second");
      yield* boat.reconcile();
      assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
      yield* access.lease.revoked;
      assert.isTrue(Exit.isFailure(yield* viewer.touch.pipe(Effect.exit)));
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect.each(["passive", "release", "disconnect", "scope"] as const)(
  "does not retain a desktop viewer after %s",
  (end) => {
    const test = setup();
    return Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        webAccess: "private",
      });
      const target = { requestId: "desktop-ended", sandboxId: "bx_23456789" };
      yield* boat.operate(
        { action: "start", projectId, requestId: target.requestId },
        ownerThreadId,
      );
      yield* boat.operate(
        { action: "prepare", projectId, requestId: target.requestId },
        ownerThreadId,
      );
      const access = yield* boat.openDesktopAccess(target, ownerThreadId, desktopDescriptor);
      const scope = yield* Scope.make();
      const viewer = yield* boat
        .registerDesktopViewer(access.binding, ownerThreadId, {
          tabId: access.viewer.tabId,
          viewerId: "viewer-ended",
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      if (end !== "passive") yield* viewer.activate;
      if (end === "release") yield* viewer.deactivate;
      if (end === "disconnect") yield* viewer.disconnect;
      if (end === "scope") yield* Scope.close(scope, Exit.void);
      test.setOwnerActive(false);
      yield* boat.reconcile();
      assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
      yield* access.lease.revoked;
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect("binds desktop usage to the exact viewer generation and hard Boat deadline", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configureDefaults({ ttlMinutes: 1, retentionDays: 14 });
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      webAccess: "private",
    });
    const target = { requestId: "desktop-generation", sandboxId: "bx_23456789" };
    yield* boat.operate({ action: "start", projectId, requestId: target.requestId }, ownerThreadId);
    yield* boat.operate(
      { action: "prepare", projectId, requestId: target.requestId },
      ownerThreadId,
    );
    const access = yield* boat.openDesktopAccess(target, ownerThreadId, desktopDescriptor);
    assert.equal(Date.parse(access.lease.expiresAt) - (yield* Clock.currentTimeMillis), 60_000);
    const identity = { tabId: access.viewer.tabId, viewerId: "viewer-same" };
    assert.isTrue(
      Exit.isFailure(
        yield* boat
          .registerDesktopViewer({ ...access.binding }, ownerThreadId, identity)
          .pipe(Effect.exit),
      ),
    );
    assert.isTrue(
      Exit.isFailure(
        yield* boat
          .registerDesktopViewer(access.binding, ownerThreadId, { ...identity, tabId: "other-tab" })
          .pipe(Effect.exit),
      ),
    );
    const previous = yield* boat.registerDesktopViewer(access.binding, ownerThreadId, identity);
    assert.isTrue(Exit.isFailure(yield* previous.touch.pipe(Effect.exit)));
    yield* previous.disconnect;
    const current = yield* boat.registerDesktopViewer(access.binding, ownerThreadId, identity);
    yield* current.activate;
    yield* previous.deactivate;
    yield* previous.disconnect;
    assert.isTrue(Exit.isFailure(yield* previous.activate.pipe(Effect.exit)));
    test.setOwnerActive(false);
    yield* TestClock.adjust("59 seconds");
    yield* current.touch;
    yield* boat.reconcile();
    assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
    yield* TestClock.adjust("1 second");
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
    yield* access.lease.revoked;
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("revokes desktop access before waiting for its forward to close", () =>
  Effect.gen(function* () {
    const closing = yield* Deferred.make<void>();
    const allowClose = yield* Deferred.make<void>();
    let holdClose = false;
    const test = setup(undefined, ownerThreadId, undefined, () =>
      holdClose
        ? Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(allowClose)))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const boat = yield* make;
      const previews = yield* PreviewManager;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        webAccess: "private",
        devCommand: "npm run dev",
      });
      const target = { requestId: "desktop-close", sandboxId: "bx_23456789" };
      yield* boat.operate(
        { action: "start", projectId, requestId: target.requestId },
        ownerThreadId,
      );
      yield* boat.operate(
        { action: "prepare", projectId, requestId: target.requestId },
        ownerThreadId,
      );
      const access = yield* boat.openDesktopAccess(target, ownerThreadId, desktopDescriptor);
      const revoked = yield* Deferred.make<void>();
      yield* access.lease.revoked.pipe(
        Effect.andThen(Deferred.succeed(revoked, undefined)),
        Effect.forkChild,
      );
      holdClose = true;
      yield* previews.close({
        threadId: ownerThreadId,
        tabId: PreviewTabId.make(access.viewer.tabId),
      });
      const reopening = yield* boat
        .openDesktopAccess(target, ownerThreadId, desktopDescriptor)
        .pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(closing), Fiber.join(reopening));
      yield* TestClock.adjust(0);
      yield* Effect.gen(function* () {
        assert.isTrue(yield* Deferred.isDone(revoked));
        assert.isTrue(Exit.isFailure(yield* access.lease.check.pipe(Effect.exit)));
      }).pipe(Effect.ensuring(Deferred.succeed(allowClose, undefined)));
      const next = yield* Fiber.join(reopening);
      assert.notStrictEqual(next.binding, access.binding);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }),
);

it.effect("authorizes a pinned SSH binding without opening a web forward", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    const ssh = yield* BoatSshTunnel.make;
    const fs = yield* FileSystem.FileSystem;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    yield* boat.operate({ action: "start", projectId, requestId: "pinned-device" }, ownerThreadId);
    const lease = yield* boat.assertActiveLease(
      { requestId: "pinned-device", sandboxId: "bx_23456789" },
      ownerThreadId,
    );
    const binding = yield* ssh.authorize(lease, Redacted.make("boat_fixture_private"));
    assert.equal(binding.hostname, "192.0.2.1");
    assert.equal(binding.port, 22);
    assert.equal(binding.username, "user");
    assert.equal(binding.hostKeyAlias, "crew-boat");
    assert.equal(
      yield* fs.readFileString(binding.knownHostsFile),
      "crew-boat ssh-ed25519 Zml4dHVyZQ==\n",
    );
    assert.equal((yield* fs.stat(binding.knownHostsFile)).mode & 0o777, 0o600);
    assert.lengthOf(test.privateForwards, 0);
    assert.lengthOf(test.openedPreviews, 0);
    test.setOwnerActive(false);
    yield* boat.reconcile();
    assert.isTrue(Exit.isFailure(yield* binding.check.pipe(Effect.exit)));
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("reopens a closed private preview while retaining the active Boat lease", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    const previews = yield* PreviewManager;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      webAccess: "private",
      devCommand: "npm run dev",
    });
    const target = { projectId, requestId: "reopen-private" };
    yield* boat.operate({ ...target, action: "start" }, ownerThreadId);
    yield* boat.operate({ ...target, action: "prepare" }, ownerThreadId);
    yield* previews.close({ threadId: ownerThreadId, tabId: PreviewTabId.make("setup-preview") });

    const reopened = yield* boat.operate({ ...target, action: "preview" }, ownerThreadId);
    assert.lengthOf(test.privateForwards, 2);
    assert.lengthOf(test.openedPreviews, 2);
    assert.equal(test.closedForwardCount(), 1);
    assert.deepEqual(reopened.instances[0]?.leases, [ownerThreadId]);
    yield* boat.operate({ ...target, action: "preview" }, ownerThreadId);
    assert.lengthOf(test.privateForwards, 2);
    assert.lengthOf(test.openedPreviews, 2);
    assert.isTrue(test.calls.every((call) => !call.includes("/host")));
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("cancels an in-flight SSH grant on lease removal without public fallback", () => {
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const test = setup((path) =>
      path.endsWith("/sshkey")
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        webAccess: "private",
        devCommand: "npm run dev",
      });
      yield* boat.operate({ action: "start", projectId, requestId: "pending" }, ownerThreadId);
      const pending = yield* boat
        .operate({ action: "prepare", projectId, requestId: "pending" }, ownerThreadId)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      test.setOwnerActive(false);
      yield* boat.reconcile();
      assert.isTrue(Exit.isFailure(yield* Fiber.join(pending)));
      assert.lengthOf(test.privateForwards, 0);
      assert.lengthOf(test.openedPreviews, 0);
      assert.isTrue(test.calls.every((call) => !call.includes("/host")));
    }).pipe(Effect.scoped, Effect.provide(test.services));
  });
});

it.effect(
  "rejects private Android without a target and changing a retained hosted VM to private",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      assert.isTrue(
        Exit.isFailure(
          yield* boat
            .configure(projectId, {
              ...DEFAULT_BOAT_PROJECT,
              enabled: true,
              webAccess: "private",
              previewKind: "android",
            })
            .pipe(Effect.exit),
        ),
      );
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      yield* boat.operate({ action: "start", projectId, requestId: "retained" }, ownerThreadId);
      yield* boat.operate({ action: "stop", projectId, requestId: "retained" });
      assert.isTrue(
        Exit.isFailure(
          yield* boat
            .configure(projectId, {
              ...DEFAULT_BOAT_PROJECT,
              enabled: true,
              webAccess: "private",
            })
            .pipe(Effect.exit),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect.each(["stop", "delete", "lease removed"] as const)(
  "opens the explicit private Android target without provisioning and releases it on %s",
  (end) => {
    const scripts: string[] = [];
    const test = setup((_path, _method, body) =>
      Effect.sync(() => {
        if (body && typeof body === "object" && "command" in body)
          scripts.push(String(body.command));
      }),
    );
    return Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        webAccess: "private",
        previewKind: "android",
        privateAndroidTarget: { hostId: "boat-android", deviceId: "selected-android" },
        devCommand: "npm run dev",
      });
      yield* boat.operate(
        { action: "start", projectId, requestId: "private-android" },
        ownerThreadId,
      );
      yield* boat.operate(
        { action: "prepare", projectId, requestId: "private-android" },
        ownerThreadId,
      );
      assert.deepEqual(test.deviceOpens, [
        {
          input: {
            threadId: ownerThreadId,
            hostId: "boat-android",
            deviceId: "selected-android",
            platform: "android",
            boot: false,
            includeAgentTarget: true,
          },
          workspaceRoot: process.cwd(),
          hostname: "192.0.2.1",
        },
      ]);
      assert.isTrue(
        test.calls.every((call) => !call.includes("/host") && !call.includes("/desktop")),
      );
      assert.isTrue(
        scripts.every(
          (script) => !/sdkmanager|avdmanager|adb |mobile:install|expo run:android/.test(script),
        ),
      );
      assert.lengthOf(test.privateForwards, 0);
      assert.lengthOf(test.openedPreviews, 0);
      yield* boat.operate(
        { action: "preview", projectId, requestId: "private-android" },
        ownerThreadId,
      );
      assert.lengthOf(test.deviceOpens, 1);
      if (end === "lease removed") {
        test.setOwnerActive(false);
        yield* boat.reconcile();
      } else {
        yield* boat.operate({ action: end, projectId, requestId: "private-android" });
      }
      yield* test.deviceReleased;
      assert.equal(test.deviceReleaseCount(), 1);
      assert.lengthOf(test.deviceSessions, 0);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect("reopens a closed private Android session without accepting a foreign lease", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      webAccess: "private",
      previewKind: "android",
      privateAndroidTarget: { hostId: "boat-android", deviceId: "selected-android" },
      devCommand: "npm run dev",
    });
    yield* boat.operate(
      { action: "start", projectId, requestId: "private-android" },
      ownerThreadId,
    );
    yield* boat.operate(
      { action: "prepare", projectId, requestId: "private-android" },
      ownerThreadId,
    );
    const stranger = ThreadId.make("stranger-android");
    test.setThread(stranger, { activeRunId: RunId.make("stranger-run") });
    assert.isTrue(
      Exit.isFailure(
        yield* boat
          .operate({ action: "preview", projectId, requestId: "private-android" }, stranger)
          .pipe(Effect.exit),
      ),
    );
    assert.equal(test.deviceReleaseCount(), 0);
    test.deviceSessions.length = 0;
    yield* boat.operate(
      { action: "preview", projectId, requestId: "private-android" },
      ownerThreadId,
    );
    assert.lengthOf(test.deviceOpens, 2);
    assert.equal(test.deviceReleaseCount(), 1);
    assert.lengthOf(test.deviceSessions, 1);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("cancels an in-flight private Android open when the lease ends", () => {
  const entered = Deferred.makeUnsafe<void>();
  const waiting = Deferred.makeUnsafe<void>();
  const test = setup(undefined, ownerThreadId, () =>
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(waiting))),
  );
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      webAccess: "private",
      previewKind: "android",
      privateAndroidTarget: { hostId: "boat-android", deviceId: "selected-android" },
      devCommand: "npm run dev",
    });
    yield* boat.operate(
      { action: "start", projectId, requestId: "private-android" },
      ownerThreadId,
    );
    const opening = yield* boat
      .operate({ action: "prepare", projectId, requestId: "private-android" }, ownerThreadId)
      .pipe(Effect.exit, Effect.forkChild);
    yield* Effect.raceFirst(Deferred.await(entered), Fiber.join(opening));
    assert.lengthOf(test.deviceOpens, 1);
    test.setOwnerActive(false);
    yield* boat.reconcile();
    assert.isTrue(Exit.isFailure(yield* Fiber.join(opening)));
    yield* test.deviceReleased;
    assert.lengthOf(test.deviceSessions, 0);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("reads bounded measured history without preview work and retains stale samples", () => {
  let unavailable = false;
  const test = setup((path) =>
    unavailable && path.includes("until=")
      ? Effect.fail(new BoatError({ category: "provider" }))
      : Effect.void,
  );
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00Z"));
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      yield* boat.operate({ action: "start", projectId, requestId: "analytics" }, ownerThreadId);
      yield* TestClock.adjust("12 hours");
      const offset = test.calls.length;
      const first = yield* boat.read(projectId, { range: "day", threadId: ownerThreadId });
      assert.equal(first.instances.length, 0);
      assert.equal(first.analytics?.instances.length, 1);
      assert.equal(first.analytics?.instances[0]?.points.length, 3);
      assert.equal(first.analytics?.instances[0]?.points[0]?.seconds, 3600);
      assert.equal(first.analytics?.instances[0]?.points[0]?.dollars, 0.01);
      assert.ok(
        test.calls
          .slice(offset)
          .every((call) => !call.includes("/commands") && !call.includes("/host")),
      );
      const count = test.calls.filter((call) => call.includes("until=")).length;
      yield* boat.read(projectId, { range: "day", threadId: ownerThreadId });
      assert.equal(test.calls.filter((call) => call.includes("until=")).length, count);
      unavailable = true;
      yield* TestClock.adjust("2 minutes");
      const stale = yield* boat.read(projectId, { range: "day", threadId: ownerThreadId });
      assert.equal(stale.analytics?.instances[0]?.points[0]?.dollars, 0.01);
      assert.equal(stale.analytics?.instances[0]?.points[0]?.status, "stale");
    }).pipe(Effect.scoped);
    const restarted = yield* make;
    const restored = yield* restarted.read(projectId, { range: "day" });
    assert.equal(restored.analytics?.instances[0]?.points[0]?.dollars, 0.01);
    assert.equal(restored.analytics?.instances[0]?.points[0]?.status, "stale");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("discards analytics from a disconnected Boat account", () => {
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = false;
    const test = setup((path) =>
      path.includes("until=") && hold
        ? Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          })
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00Z"));
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      yield* boat.operate(
        { action: "start", projectId, requestId: "disconnect-read" },
        ownerThreadId,
      );
      yield* boat.operate({ action: "stop", projectId, requestId: "disconnect-read" });
      yield* TestClock.setTime(Date.parse("2026-11-01T04:00:00Z"));
      hold = true;
      const read = yield* boat.read(projectId, { range: "day" }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* boat.disconnect;
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.await(read);
      assert.isTrue(Exit.isFailure(result));
      const current = yield* boat.read(projectId, { range: "day" });
      assert.isFalse(current.configured);
      assert.equal(current.analytics?.instances[0]?.points[0]?.dollars, null);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }).pipe(Effect.scoped);
});

it.effect(
  "estimates shared thread usage from recorded lease intervals and retains it after restart",
  () => {
    const test = setup();
    const otherThreadId = ThreadId.make("other-thread");
    test.setThread(otherThreadId, {
      activeRunId: RunId.make("other-run"),
      lineage: {
        rootThreadId: ownerThreadId,
        parentThreadId: ownerThreadId,
        relationshipToParent: "subagent",
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00Z"));
      const vm = yield* Effect.gen(function* () {
        const boat = yield* make;
        yield* boat.connect(Redacted.make("boat_fixture_private"));
        yield* boat.configure(projectId, {
          ...DEFAULT_BOAT_PROJECT,
          enabled: true,
          inheritDefaults: false,
          ttlMinutes: 1440,
        });
        yield* boat.operate(
          { action: "start", projectId, requestId: "shared-usage" },
          ownerThreadId,
        );
        yield* TestClock.setTime(Date.parse("2026-11-01T01:00:00Z"));
        yield* boat.operate(
          { action: "renew", projectId, requestId: "shared-usage" },
          otherThreadId,
        );
        yield* TestClock.setTime(Date.parse("2026-11-01T02:00:00Z"));
        yield* boat.operate({ action: "stop", projectId, requestId: "shared-usage" });
        yield* TestClock.setTime(Date.parse("2026-11-01T04:00:00Z"));
        const owner = yield* boat.read(projectId, { range: "day", threadId: ownerThreadId });
        const other = yield* boat.read(projectId, { range: "day", threadId: otherThreadId });
        const vm = owner.analytics!.instances[0]!;
        assert.closeTo(vm.threadPoints[0]!.dollars!, 0.0075, 0.000001);
        assert.closeTo(other.analytics!.instances[0]!.threadPoints[0]!.dollars!, 0.0025, 0.000001);
        assert.equal(vm.threadPoints[0]!.attribution, "estimated");
        assert.equal(vm.points[0]!.dollars, 0.01);
        assert.equal(vm.starts, 1);
        assert.equal(vm.stops, 1);
        return vm;
      }).pipe(Effect.scoped);
      const reopened = yield* make;
      const restored = yield* reopened.read(projectId, { range: "day", threadId: ownerThreadId });
      assert.deepEqual(restored.analytics!.instances[0]!.threadPoints, vm.threadPoints);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect(
  "bounds legacy VM history, deduplicates shared VMs and excludes private runtime fields",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00Z"));
      const started = yield* Effect.gen(function* () {
        const boat = yield* make;
        yield* boat.connect(Redacted.make("boat_fixture_private"));
        yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
        return yield* boat.operate(
          { action: "start", projectId, requestId: "legacy" },
          ownerThreadId,
        );
      }).pipe(Effect.scoped);
      const instances = Array.from({ length: 9 }, (_, index) => ({
        ...started.instances[0]!,
        requestId: `legacy-${index}`,
        sandboxId: `bx_fixture${index}`,
        leases: [ownerThreadId, ThreadId.make("other-thread")],
        previewUrl: "https://preview.test/?token=do-not-copy",
        output: "private command output",
      }));
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${config.stateDir}/boat.json`,
        JSON.stringify({
          period: "2026-10",
          projects: started.projects,
          instances: [...instances, { ...instances[0]!, requestId: "duplicate" }],
        }),
      );
      yield* TestClock.setTime(Date.parse("2026-11-30T12:00:00Z"));
      const restored = yield* make;
      const offset = test.calls.length;
      const result = yield* restored.read(projectId, { range: "month", threadId: ownerThreadId });
      assert.equal(result.analytics?.instances.length, 8);
      assert.equal(result.analytics?.omittedInstances, 1);
      assert.equal(result.analytics?.activeInstances.default, 9);
      assert.equal(test.calls.slice(offset).filter((call) => call.includes("until=")).length, 64);
      assert.equal(result.analytics?.instances[0]?.historyKnownSince, null);
      assert.equal(result.analytics?.instances[0]?.threadPoints[0]?.dollars, null);
      assert.equal(result.analytics?.instances[0]?.threadPoints[0]?.attribution, "unknown");
      assert.deepEqual(result.analytics?.instances[0]?.threadIds, [
        ownerThreadId,
        ThreadId.make("other-thread"),
      ]);
      assert.isFalse(JSON.stringify(result.analytics).includes("do-not-copy"));
      assert.isFalse(JSON.stringify(result.analytics).includes("private command output"));
      assert.isFalse(JSON.stringify(result.analytics).includes("boat_fixture_private"));
      const unrelated = yield* restored.read(projectId, {
        range: "month",
        threadId: ThreadId.make("unrelated"),
      });
      assert.equal(unrelated.analytics?.instances.length, 0);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect(
  "persists account secrets separately, deduplicates starts and retains ownership after restart",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        maxConcurrent: 1,
      });
      yield* boat.operate({ action: "start", projectId, requestId: "first" }, ownerThreadId);
      const reopened = yield* make;
      const state = yield* reopened.operate(
        { action: "start", projectId, requestId: "first" },
        ownerThreadId,
      );
      assert.equal(test.calls.filter((call) => call === "POST /sandboxes").length, 1);
      assert.equal(state.instances[0]?.sandboxId, "bx_23456789");
      const legacyInstance = { ...state.instances[0] };
      delete legacyInstance.savedSnapshot;
      assert.isNull((yield* decodeInstance(legacyInstance)).savedSnapshot);
      assert.isFalse(JSON.stringify(state).includes("boat_fixture_private"));
      const denied = yield* reopened
        .operate({ action: "start", projectId, requestId: "second" })
        .pipe(Effect.flip);
      assert.equal(denied.category, "capacity");
      yield* reopened.operate({ action: "stop", projectId, requestId: "first" }, ownerThreadId);
      yield* reopened.operate({ action: "delete", projectId, requestId: "first" });
      yield* reopened.disconnect;
      assert.isFalse((yield* reopened.read()).configured);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect("reserves the full auto-stop cost before creating a billable machine", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      size: "default",
      ttlMinutes: 120,
      inheritDefaults: false,
      budgetUsd: 0.1,
    });
    yield* boat.operate({ action: "start", projectId, requestId: "first" });
    const denied = yield* boat
      .operate({ action: "start", projectId, requestId: "second" })
      .pipe(Effect.flip);
    assert.equal(denied.category, "budget");
    assert.equal(test.calls.filter((call) => call === "POST /sandboxes").length, 1);
    yield* boat.operate({ action: "stop", projectId, requestId: "first" });
    yield* boat.operate({ action: "start", projectId, requestId: "second" });
    yield* boat.operate({ action: "stop", projectId, requestId: "second" });
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      ttlMinutes: 150,
      inheritDefaults: false,
      budgetUsd: 0.105,
    });
    const resumeDenied = yield* boat
      .operate({ action: "resume", projectId, requestId: "first" })
      .pipe(Effect.flip);
    assert.equal(resumeDenied.category, "budget");
    assert.isFalse(test.calls.includes("POST /sandboxes/bx_23456789/resume"));
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("prepares project commands and uses an embedded desktop for Android previews", () => {
  let execBody: unknown;
  const test = setup((path, method, body) =>
    Effect.sync(() => {
      if (path.endsWith("/commands") && method === "POST") execBody = body;
    }),
  );
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "boat-project-" });
    test.setProjectRoot(root);
    yield* fs.writeFileString(
      `${root}/package.json`,
      JSON.stringify({
        scripts: { dev: "vite", test: "vitest" },
        packageManager: "pnpm@12.14.0",
        devDependencies: { "vite-plus": "catalog:" },
      }),
    );
    yield* fs.writeFileString(`${root}/pnpm-workspace.yaml`, "catalog:\n  vite-plus: 1.4.0\n");
    const workflow = `${root}/.github/workflows/crew-boat.yml`;
    yield* fs.makeDirectory(`${root}/.github/workflows`, { recursive: true });
    yield* fs.writeFileString(workflow, "name: Existing CI\non: workflow_dispatch\n");
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    const configured = yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      previewKind: "android",
    });
    assert.equal(yield* fs.readFileString(workflow), "name: Existing CI\non: workflow_dispatch\n");
    const conflictingCi = yield* boat
      .configure(projectId, {
        ...configured.projects[projectId]!,
        ciEnabled: true,
      })
      .pipe(Effect.flip);
    assert.equal(conflictingCi.category, "conflict");
    assert.include(configured.projects[projectId]!.setupCommand, "vite-plus@1.4.0");
    assert.include(
      configured.projects[projectId]!.setupCommand,
      'export PATH="$PWD/node_modules/.bin:$PATH"',
    );
    assert.equal(configured.projects[projectId]!.devCommand, "./node_modules/.bin/vp run dev");
    yield* boat.operate({ action: "start", projectId, requestId: "android" });
    yield* boat.operate({
      action: "exec",
      projectId,
      requestId: "android",
      command: "cat restored.txt",
    });
    assert.deepEqual(execBody, {
      command:
        'mkdir -p /home/user/crew && cd /home/user/crew || exit\nexport PATH="$PWD/node_modules/.bin:$PATH"\ncat restored.txt',
      timeoutSeconds: 20,
    });
    const preview = yield* boat.operate({ action: "preview", projectId, requestId: "android" });
    assert.equal(preview.instances[0]?.previewUrl, "https://preview.example.test/android");
    assert.include(test.calls, "POST /sandboxes/bx_23456789/desktop?vnc=1");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("rejects preview ownership outside the selected project before starting compute", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    const error = yield* boat
      .operate({
        action: "start",
        projectId,
        requestId: "foreign",
        threadId: ThreadId.make("foreign-thread"),
      })
      .pipe(Effect.flip);
    assert.equal(error.category, "not_found");
    assert.isFalse(test.calls.includes("POST /sandboxes"));
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect(
  "keeps active agent leases within their TTL and stops after the last owner finishes",
  () =>
    Effect.gen(function* () {
      const test = setup();
      yield* Effect.gen(function* () {
        const boat = yield* make;
        yield* boat.connect(Redacted.make("boat_fixture_private"));
        yield* boat.configureDefaults({ ttlMinutes: 1, retentionDays: 14 });
        yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
        yield* boat.operate({ action: "start", projectId, requestId: "lease" }, ownerThreadId);
        yield* TestClock.adjust("31 seconds");
        yield* boat.reconcile();
        assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
        test.setOwnerActive(false);
        yield* boat.reconcile();
        assert.notInclude(test.calls, "PATCH /sandboxes/bx_23456789");
        assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
        assert.deepEqual((yield* boat.read(projectId)).instances[0]?.leases, []);
      }).pipe(Effect.scoped, Effect.provide(test.services));
    }),
);

it.effect("uses the duration chosen for each start, renewal and resume", () => {
  const durations: Array<number | undefined> = [];
  const test = setup((path, method, body) =>
    Effect.sync(() => {
      if (
        (path === "/sandboxes" && method === "POST") ||
        method === "PATCH" ||
        path.endsWith("/resume")
      )
        durations.push((body as { ttlSeconds?: number }).ttlSeconds);
    }),
  );
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: false });
    const startedAt = yield* Clock.currentTimeMillis;
    const started = yield* boat.operate(
      { action: "start", projectId, requestId: "duration", ttlMinutes: 15 },
      ownerThreadId,
    );
    assert.equal(Date.parse(started.instances[0]!.expiresAt), startedAt + 15 * 60_000);
    const renewed = yield* boat.operate(
      { action: "renew", projectId, requestId: "duration", ttlMinutes: 30 },
      ownerThreadId,
    );
    assert.equal(Date.parse(renewed.instances[0]!.expiresAt), startedAt + 30 * 60_000);
    yield* boat.operate({ action: "stop", projectId, requestId: "duration" });
    const resumed = yield* boat.operate(
      { action: "resume", projectId, requestId: "duration", ttlMinutes: 10 },
      ownerThreadId,
    );
    assert.equal(Date.parse(resumed.instances[0]!.expiresAt), startedAt + 10 * 60_000);
    assert.deepEqual(durations, [900, 1800, 600]);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("warns the owner before expiry without extending an idle VM", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    const started = yield* boat.operate(
      { action: "start", projectId, requestId: "warning", ttlMinutes: 6 },
      ownerThreadId,
    );
    const warnings = yield* Stream.toPull(boat.expiring);
    yield* TestClock.adjust("61 seconds");
    yield* boat.reconcile();
    const [warning] = yield* warnings;
    assert.deepEqual(warning, {
      projectId,
      threadId: ownerThreadId,
      requestId: "warning",
      sandboxId: "bx_23456789",
      expiresAt: started.instances[0]!.expiresAt,
    });
    test.setOwnerActive(false);
    yield* TestClock.adjust("5 minutes");
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
    assert.notInclude(test.calls, "PATCH /sandboxes/bx_23456789");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("continues deadline cleanup when status refresh or another VM stop fails", () => {
  let fail = false;
  const test = setup((path) =>
    fail && (path === "/limits" || path === "/sandboxes/bx_23456789/stop")
      ? Effect.fail(new BoatError({ category: "provider", status: 503 }))
      : Effect.void,
  );
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configureDefaults({ ttlMinutes: 1, retentionDays: 14 });
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      yield* boat.operate({ action: "start", projectId, requestId: "unavailable" }, ownerThreadId);
    }).pipe(Effect.scoped);
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const filename = `${config.stateDir}/boat.json`;
    const stored = JSON.parse(yield* fs.readFileString(filename));
    stored.instances.push({
      ...stored.instances[0],
      requestId: "healthy",
      sandboxId: "bx_healthy",
    });
    yield* fs.writeFileString(filename, JSON.stringify(stored));
    const boat = yield* make;
    fail = true;
    yield* TestClock.adjust("61 seconds");
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
    assert.include(test.calls, "POST /sandboxes/bx_healthy/stop");
    assert.notInclude(test.calls, "DELETE /sandboxes/bx_healthy");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("binds the caller worktree across restart and rejects a later source rewrite", () => {
  const test = setup();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "boat-source-" });
    const callerRoot = `${root}/caller`;
    const otherThreadId = ThreadId.make("other-source");
    test.setProjectRoot(root);
    test.setThread(ownerThreadId, { worktreePath: callerRoot });
    test.setThread(otherThreadId, { worktreePath: null });
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      devCommand: "node server.js",
    });
    yield* boat.operate({ action: "start", projectId, requestId: "source" }, ownerThreadId);
    const reopened = yield* make;
    yield* reopened.operate(
      { action: "prepare", projectId, requestId: "source", threadId: otherThreadId },
      ownerThreadId,
    );
    assert.isAbove(test.gitCwds.length, 0);
    assert.isTrue(test.gitCwds.every((cwd) => cwd === callerRoot));
    const callsBefore = test.calls.length;
    test.setThread(ownerThreadId, { worktreePath: `${root}/moved` });
    const moved = yield* reopened
      .operate({ action: "prepare", projectId, requestId: "source" }, ownerThreadId)
      .pipe(Effect.flip);
    assert.equal(moved.category, "conflict");
    const foreign = yield* reopened
      .operate({ action: "prepare", projectId, requestId: "source" }, otherThreadId)
      .pipe(Effect.flip);
    assert.equal(foreign.category, "conflict");
    test.setThread(otherThreadId, { worktreePath: callerRoot });
    for (const action of ["stop", "delete", "cancel"] as const) {
      const denied = yield* reopened
        .operate({ action, projectId, requestId: "source", threadId: ownerThreadId }, otherThreadId)
        .pipe(Effect.flip);
      assert.equal(denied.category, "conflict");
    }
    assert.equal(test.calls.length, callsBefore);
    yield* reopened.operate({ action: "cancel", projectId, requestId: "source" }, ownerThreadId);
    assert.include(test.calls, "DELETE /sandboxes/bx_23456789/commands/123");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect.each(["stop", "delete", "cancel"] as const)(
  "allows an owner's child to %s without changing the bound source",
  (action) => {
    const test = setup();
    return Effect.gen(function* () {
      const childThreadId = ThreadId.make("boat-control-child");
      test.setThread(ownerThreadId, { worktreePath: "/work/owner" });
      test.setThread(childThreadId, {
        worktreePath: "/work/child",
        lineage: {
          rootThreadId: ownerThreadId,
          parentThreadId: ownerThreadId,
          relationshipToParent: "subagent",
        },
      });
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        devCommand: "node server.js",
      });
      yield* boat.operate({ action: "start", projectId, requestId: "control" }, ownerThreadId);
      yield* boat.operate({ action: "prepare", projectId, requestId: "control" }, ownerThreadId);
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const sourceBefore = yield* fs.readFileString(`${config.stateDir}/boat-work.json`);
      const controlled = yield* boat.operate(
        { action, projectId, requestId: "control" },
        childThreadId,
      );
      assert.equal(controlled.instances[0]?.threadId, ownerThreadId);
      assert.equal(yield* fs.readFileString(`${config.stateDir}/boat-work.json`), sourceBefore);
      assert.include(
        test.calls,
        action === "cancel"
          ? "DELETE /sandboxes/bx_23456789/commands/123"
          : action === "delete"
            ? "DELETE /sandboxes/bx_23456789"
            : "POST /sandboxes/bx_23456789/stop",
      );
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect("rejects a racing unrelated owner even when its workspace matches", () => {
  const test = setup();
  const otherThreadId = ThreadId.make("other-owner");
  test.setThread(otherThreadId, {});
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    const results = yield* Effect.forEach(
      [ownerThreadId, otherThreadId],
      (id) =>
        boat
          .operate({ action: "start", projectId, requestId: "racing-owner" }, id)
          .pipe(Effect.exit),
      { concurrency: "unbounded" },
    );
    assert.equal(results.filter(Exit.isSuccess).length, 1);
    assert.equal(test.calls.filter((call) => call === "POST /sandboxes").length, 1);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("shares an owner's VM with its child without replacing the bound source", () => {
  const test = setup();
  return Effect.gen(function* () {
    const childThreadId = ThreadId.make("boat-child");
    test.setThread(ownerThreadId, { worktreePath: "/work/owner" });
    test.setThread(childThreadId, {
      worktreePath: "/work/child",
      activeRunId: RunId.make("child-run"),
      lineage: {
        rootThreadId: ownerThreadId,
        parentThreadId: ownerThreadId,
        relationshipToParent: "subagent",
      },
    });
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      devCommand: "node server.js",
    });
    yield* boat.operate({ action: "start", projectId, requestId: "shared-source" }, ownerThreadId);
    const shared = yield* boat.operate(
      { action: "start", projectId, requestId: "shared-source" },
      childThreadId,
    );
    assert.deepEqual(shared.instances[0]?.leases, [ownerThreadId, childThreadId]);
    yield* boat.operate(
      {
        action: "exec",
        projectId,
        requestId: "shared-source",
        command: "vp test run focused.test.ts",
      },
      childThreadId,
    );
    const denied = yield* boat
      .operate({ action: "prepare", projectId, requestId: "shared-source" }, childThreadId)
      .pipe(Effect.flip);
    assert.equal(denied.category, "conflict");
    const renewalDenied = yield* boat
      .operate({ action: "renew", projectId, requestId: "shared-source" }, childThreadId)
      .pipe(Effect.flip);
    assert.equal(renewalDenied.category, "conflict");
    test.setOwnerActive(false);
    yield* boat.reconcile();
    assert.deepEqual((yield* boat.read(projectId)).instances[0]?.leases, [childThreadId]);
    assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
    test.setThread(childThreadId, { worktreePath: "/work/child", activeRunId: null });
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

const transferSession: AuthenticatedSession = {
  sessionId: AuthSessionId.make("boat-transfer-session"),
  subject: "maintainer",
  method: "browser-session-cookie",
  scopes: [AuthEnvironmentMaintainScope, AuthOrchestrationOperateScope],
};

const transferFixture = Effect.fn("transferFixture")(function* (
  test: ReturnType<typeof setup>,
  legacy = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "boat-transfer-" });
  const oldRoot = `${root}/old`;
  const targetRoot = `${root}/target`;
  yield* fs.makeDirectory(oldRoot);
  yield* fs.makeDirectory(targetRoot);
  yield* fs.writeFileString(`${targetRoot}/source.ts`, "current source");
  test.setProjectRoot(root);
  test.setThread(ownerThreadId, { worktreePath: oldRoot, activeRunId: null });
  const boat = yield* make;
  yield* boat.connect(Redacted.make("boat_fixture_private"));
  yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
  yield* boat.operate({ action: "start", projectId, requestId: "transfer" }, ownerThreadId);
  yield* boat.operate({ action: "stop", projectId, requestId: "transfer" }, ownerThreadId);
  if (legacy) yield* fs.remove(`${config.stateDir}/boat-work.json`);
  const reopened = yield* make;
  yield* reopened.reconcile();
  return { boat: reopened, fs, config, oldRoot, targetRoot };
});

it.effect.each(["other-owner", "same-owner", "legacy"] as const)(
  "explicitly transfers an inactive Boat with %s source and survives reload",
  (kind) => {
    const test = setup();
    return Effect.gen(function* () {
      const { boat, targetRoot, fs, config } = yield* transferFixture(test, kind === "legacy");
      const targetThreadId =
        kind === "other-owner" ? ThreadId.make("new-boat-owner") : ownerThreadId;
      test.setThread(targetThreadId, { worktreePath: targetRoot, activeRunId: null });
      const before = test.calls.filter((call) => !call.startsWith("GET ")).length;
      const oldCache = yield* fs
        .readFileString(`${config.stateDir}/boat-work.json`)
        .pipe(Effect.orElseSucceed(() => "{}"));
      const inspected = yield* boat.transfer(
        {
          action: "inspect",
          projectId,
          requestId: "transfer",
          sandboxId: "bx_23456789",
          targetThreadId,
          receiptPaths: ["source.ts"],
        },
        transferSession,
      );
      assert.equal(inspected.committed, false);
      assert.equal(inspected.proposal.expected.ownerThreadId, ownerThreadId);
      assert.equal(inspected.proposal.expected.source === null, kind === "legacy");
      assert.equal(inspected.proposal.target.files[0]?.sha256.length, 64);
      const receipt = yield* boat.transfer(
        { action: "commit", proposal: inspected.proposal },
        transferSession,
      );
      assert.equal(receipt.committed, true);
      assert.equal(test.calls.filter((call) => !call.startsWith("GET ")).length, before);
      const persisted = JSON.parse(yield* fs.readFileString(`${config.stateDir}/boat.json`));
      assert.equal(persisted.instances[0].threadId, targetThreadId);
      assert.deepEqual(persisted.instances[0].leases, []);
      const stale = yield* boat
        .transfer({ action: "commit", proposal: inspected.proposal }, transferSession)
        .pipe(Effect.flip);
      assert.equal("category" in stale ? stale.category : stale._tag, "conflict");
      yield* fs.writeFileString(`${config.stateDir}/boat-work.json`, oldCache);
      const reloaded = yield* make;
      const recovered = yield* reloaded.transfer(
        {
          action: "inspect",
          projectId,
          requestId: "transfer",
          sandboxId: "bx_23456789",
          targetThreadId,
          receiptPaths: ["source.ts"],
        },
        transferSession,
      );
      assert.equal(recovered.proposal.expected.source?.workspaceRoot, targetRoot);
      assert.isNull(recovered.proposal.expected.source?.sourceTree);
      yield* reloaded.operate(
        { action: "resume", projectId, requestId: "transfer" },
        targetThreadId,
      );
      const state = yield* reloaded.read(projectId);
      assert.equal(state.instances[0]?.threadId, targetThreadId);

      if (kind === "other-owner") {
        const denied = yield* reloaded
          .operate({ action: "renew", projectId, requestId: "transfer" }, ownerThreadId)
          .pipe(Effect.flip);
        assert.equal(denied.category, "conflict");
      }
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect("rejects a source handoff during the final transfer inspection", () => {
  const test = setup();
  return Effect.gen(function* () {
    const { boat, targetRoot, fs, config } = yield* transferFixture(test);
    const targetThreadId = ThreadId.make("transfer-target");
    test.setThread(targetThreadId, { worktreePath: targetRoot, activeRunId: null });
    const { proposal } = yield* boat.transfer(
      {
        action: "inspect",
        projectId,
        requestId: "transfer",
        sandboxId: "bx_23456789",
        targetThreadId,
        receiptPaths: ["source.ts"],
      },
      transferSession,
    );
    let reads = 0;
    test.setOnGitRead(() => {
      if (++reads === 2)
        test.setThread(targetThreadId, {
          worktreePath: `${targetRoot}/changed`,
          activeRunId: null,
        });
    });
    const result = yield* boat
      .transfer({ action: "commit", proposal }, transferSession)
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    assert.equal(reads, 2);
    const stored = JSON.parse(yield* fs.readFileString(`${config.stateDir}/boat.json`));
    assert.equal(stored.instances[0].threadId, ownerThreadId);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect.each([[], [AuthEnvironmentMaintainScope], [AuthOrchestrationOperateScope]] as const)(
  "requires both authenticated transfer scopes: %j",
  (scopes) => {
    const test = setup();
    return Effect.gen(function* () {
      const { boat } = yield* transferFixture(test);
      const denied = yield* boat
        .transfer(
          {
            action: "inspect",
            projectId,
            requestId: "transfer",
            sandboxId: "bx_23456789",
            targetThreadId: ownerThreadId,
            receiptPaths: ["source.ts"],
          },
          { ...transferSession, scopes },
        )
        .pipe(Effect.flip);
      assert.equal(denied._tag, "EnvironmentAuthorizationError");
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect.each([
  "project",
  "vm",
  "target-project",
  "deleted-target",
  "target-path",
  "target-file",
  "revision",
  "owner",
  "source",
  "active-lease",
  "pending-operation",
] as const)("rejects a mismatched Boat transfer claim: %s", (kind) => {
  const test = setup();
  return Effect.gen(function* () {
    const { boat, targetRoot, fs, config } = yield* transferFixture(test);
    test.setThread(ownerThreadId, { worktreePath: targetRoot, activeRunId: null });
    const input = {
      action: "inspect" as const,
      projectId,
      requestId: "transfer",
      sandboxId: "bx_23456789",
      targetThreadId: ownerThreadId,
      receiptPaths: ["source.ts"],
    };
    const inspected = yield* boat.transfer(input, transferSession);
    const proposal = {
      ...inspected.proposal,
      expected: { ...inspected.proposal.expected },
      target: { ...inspected.proposal.target },
    };
    if (kind === "project") proposal.projectId = ProjectId.make("wrong-project");
    if (kind === "vm") proposal.sandboxId = "bx_different";
    if (kind === "target-project")
      test.setThread(ownerThreadId, {
        worktreePath: targetRoot,
        projectId: ProjectId.make("wrong-project"),
      });
    if (kind === "deleted-target")
      test.setThread(ownerThreadId, {
        worktreePath: targetRoot,
        deletedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
      });
    if (kind === "target-path")
      test.setThread(ownerThreadId, { worktreePath: `${targetRoot}/changed` });
    if (kind === "target-file") yield* fs.writeFileString(`${targetRoot}/source.ts`, "changed");
    if (kind === "revision") proposal.expected.revision++;
    if (kind === "owner") proposal.expected.ownerThreadId = ThreadId.make("different-owner");
    if (kind === "source" && proposal.expected.source)
      proposal.expected.source = {
        ...proposal.expected.source,
        workspaceRoot: "/different-source",
      };
    let selected = boat;
    if (kind === "active-lease" || kind === "pending-operation") {
      const stored = JSON.parse(yield* fs.readFileString(`${config.stateDir}/boat.json`));
      if (kind === "active-lease") stored.instances[0].leases = [ThreadId.make("active-neighbor")];
      else stored.instances[0].resumeOperation = { id: "pending", ttlSeconds: 60 };
      yield* fs.writeFileString(`${config.stateDir}/boat.json`, JSON.stringify(stored));
      selected = yield* make;
    }
    const before = test.calls.filter((call) => !call.startsWith("GET ")).length;
    const denied = yield* selected
      .transfer({ action: "commit", proposal }, transferSession)
      .pipe(Effect.flip);
    assert.equal(denied._tag, "BoatError");
    assert.equal(test.calls.filter((call) => !call.startsWith("GET ")).length, before);
    const stored = JSON.parse(yield* fs.readFileString(`${config.stateDir}/boat.json`));
    assert.equal(stored.instances[0].threadId, ownerThreadId);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("does not adopt a caller worktree for an existing unbound machine", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      devCommand: "node server.js",
    });
    yield* boat.operate({ action: "start", projectId, requestId: "legacy" });
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.remove(`${config.stateDir}/boat-work.json`);
    test.setThread(ownerThreadId, { worktreePath: "/work/caller" });
    const reopened = yield* make;
    const error = yield* reopened
      .operate({ action: "prepare", projectId, requestId: "legacy" }, ownerThreadId)
      .pipe(Effect.flip);
    assert.equal(error.category, "conflict");
    assert.deepEqual(test.gitCwds, []);
    assert.notInclude(test.calls, "PUT /sandboxes/bx_23456789/files");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect.each([
  { kind: "command", awaited: true, holds: true },
  { kind: "command", holds: false },
  { kind: "background_task", holds: true },
  { kind: "subagent", holds: true },
] as const)("honors structured background liveness: %j", (task) => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    yield* boat.operate({ action: "start", projectId, requestId: "background" }, ownerThreadId);
    test.setOwnerActive(false);
    test.setThread(ownerThreadId, {
      pendingBackgroundTasks: [
        {
          taskId: "check",
          kind: task.kind,
          ...("awaited" in task ? { awaited: task.awaited } : {}),
        },
      ],
    });
    yield* boat.reconcile();
    assert.equal(test.calls.includes("POST /sandboxes/bx_23456789/stop"), !task.holds);
    test.setThread(ownerThreadId, { pendingBackgroundTasks: [] });
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("transfers a finished parent's lease to its active projected child", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    yield* boat.operate({ action: "start", projectId, requestId: "child-task" }, ownerThreadId);
    test.setOwnerActive(false);
    const child = { threadId: ownerThreadId, status: "running" } as OrchestrationV2Subagent;
    test.setSubagents(ownerThreadId, [child]);
    yield* boat.reconcile();
    assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
    assert.deepEqual((yield* boat.read(projectId)).instances[0]?.leases, [ownerThreadId]);
    const childThreadId = ThreadId.make("projected-child");
    test.setSubagents(ownerThreadId, [{ ...child, childThreadId, status: "completed" }]);
    test.setThread(childThreadId, {
      activeRunId: null,
      pendingBackgroundTasks: [{ taskId: "grandchild", kind: "subagent" }],
    });
    yield* boat.reconcile();
    assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
    assert.deepEqual((yield* boat.read(projectId)).instances[0]?.leases, [childThreadId]);
    test.setOwnerActive(true);
    test.setThread(childThreadId, { activeRunId: null, pendingBackgroundTasks: [] });
    yield* boat.reconcile();
    assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
    assert.deepEqual((yield* boat.read(projectId)).instances[0]?.leases, [ownerThreadId]);
    test.setOwnerActive(false);
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect.each([
  ["completed", undefined],
  ["completed", null],
  ["failed", null],
  ["expired", null],
  ["missing", null],
  ["unavailable", null],
] as const)(
  "tracks only the started check's command ID until %s with exitCode=%s",
  ([end, exitCode]) => {
    let statusFailure: number | null = null;
    const test = setup((path) =>
      path.endsWith("/commands/456") && statusFailure !== null
        ? Effect.fail(new BoatError({ category: "provider", status: statusFailure }))
        : Effect.void,
    );
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const boat = yield* make;
        yield* boat.connect(Redacted.make("boat_fixture_private"));
        yield* boat.configureDefaults({ ttlMinutes: 1, retentionDays: 14 });
        yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
        yield* boat.operate({ action: "start", projectId, requestId: "command" }, ownerThreadId);
        test.setCommandResult({ processId: 456, ...(exitCode === undefined ? {} : { exitCode }) });
        yield* boat.operate(
          {
            action: "exec",
            projectId,
            requestId: "command",
            command: "vp test run focused.test.ts",
          },
          ownerThreadId,
        );
      }).pipe(Effect.scoped);
      test.setCommandStatus({
        processId: 456,
        ...(exitCode === undefined ? {} : { exitCode }),
        status: "running",
        known: true,
        running: true,
        stdout: "",
        stderr: "",
      });
      const reopened = yield* make;
      test.setOwnerActive(false);
      yield* reopened.reconcile();
      assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
      assert.include(test.calls, "GET /sandboxes/bx_23456789/commands/456");
      if (end === "completed" || end === "failed")
        test.setCommandStatus({ exitCode: end === "completed" ? 0 : 1 });
      else if (end === "missing") statusFailure = 404;
      else if (end === "unavailable") {
        statusFailure = 503;
        yield* reopened.reconcile();
        assert.notInclude(test.calls, "POST /sandboxes/bx_23456789/stop");
        yield* TestClock.adjust("61 seconds");
      } else yield* TestClock.adjust("61 seconds");
      yield* reopened.reconcile();
      assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
      assert.notInclude(test.calls, "PATCH /sandboxes/bx_23456789");
      assert.deepEqual((yield* reopened.read(projectId)).instances[0]?.leases, []);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect.each(["ttl", "budget"] as const)("stops active owners at the hard %s limit", (limit) => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configureDefaults({ ttlMinutes: 1, retentionDays: 14 });
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true, budgetUsd: 0.1 });
    yield* boat.operate({ action: "start", projectId, requestId: "limit" }, ownerThreadId);
    if (limit === "ttl") yield* TestClock.adjust("61 seconds");
    else test.setCost(0.1);
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
    assert.notInclude(test.calls, "PATCH /sandboxes/bx_23456789");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("stops a completed setup preview when the last agent finishes", () => {
  const threadId = ThreadId.make(`boat-setup:${projectId}`);
  const test = setup(undefined, threadId);
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configureDefaults({ ttlMinutes: 1, retentionDays: 14 });
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      previewKind: "android",
      devCommand: "npm run dev",
    });
    const requestId = `boat-setup:${projectId}`;
    yield* boat.operate({ action: "start", projectId, requestId }, threadId);
    yield* boat.operate({ action: "prepare", projectId, requestId }, threadId);
    yield* boat.operate({ action: "preview", projectId, requestId }, threadId);
    test.setOwnerActive(false);
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
    assert.notInclude(test.calls, "PATCH /sandboxes/bx_23456789");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("stops and deletes owned machines after their project is removed", () => {
  const test = setup();
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configureDefaults({ ttlMinutes: 1, retentionDays: 0 });
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    yield* boat.operate({ action: "start", projectId, requestId: "orphan" });
    test.removeProject();
    yield* TestClock.adjust("61 seconds");
    yield* boat.reconcile();
    yield* boat.reconcile();
    assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
    assert.include(test.calls, "DELETE /sandboxes/bx_23456789");
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("uploads source archives in bounded chunks and assembles them before setup", () => {
  const uploads: { path: string; content: string }[] = [];
  const commands: string[] = [];
  let command = "";
  const test = setup((path, method, body) =>
    Effect.sync(() => {
      if (path.endsWith("/files") && method === "PUT")
        uploads.push(body as (typeof uploads)[number]);
      if (path.endsWith("/commands")) {
        const next = (body as { command: string }).command;
        commands.push(next);
        if (next.includes("python3")) command = next;
      }
    }),
  );
  const bytes = new Uint8Array(6 * 1024 * 1024).fill(17);
  test.setArchive(bytes);
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      devCommand: "node server.js",
    });
    yield* boat.operate({ action: "start", projectId, requestId: "chunks" });
    yield* boat.operate({ action: "prepare", projectId, requestId: "chunks" });
    assert.deepEqual(
      uploads.map((part) => Buffer.from(part.content, "base64").length),
      [4 * 1024 * 1024, 2 * 1024 * 1024],
    );
    assert.deepEqual(
      Buffer.concat(uploads.map((part) => Buffer.from(part.content, "base64"))),
      Buffer.from(bytes),
    );
    assert.include(
      command,
      `cat /home/user/${uploads[0]!.path} /home/user/${uploads[1]!.path} > /home/user/${uploads[0]!.path.replace(/\.part-0$/, "")}`,
    );
    assert.isBelow(command.indexOf("cat "), command.indexOf("python3"));
    assert.isBelow(
      commands.indexOf(command),
      commands.findIndex((entry) => entry.includes("node server.js")),
    );
    const firstProcessId = (yield* boat.read(projectId)).instances[0]!.processId;
    const starts = commands.filter((entry) => entry.includes("node server.js")).length;
    test.setCommandStatus({
      processId: firstProcessId,
      exitCode: null,
      status: "running",
      known: true,
      running: true,
      stdout: "",
      stderr: "",
    });
    yield* boat.operate({ action: "prepare", projectId, requestId: "chunks" });
    assert.equal((yield* boat.read(projectId)).instances[0]!.processId, firstProcessId);
    assert.include(test.calls, `GET /sandboxes/bx_23456789/commands/${firstProcessId}`);
    assert.notInclude(command, "node server.js");
    assert.equal(commands.filter((entry) => entry.includes("node server.js")).length, starts);
    test.setCommandResult({ processId: 123, exitCode: 1 });
    const failed = yield* boat
      .operate({ action: "prepare", projectId, requestId: "chunks" })
      .pipe(Effect.flip);
    assert.equal(failed.category, "provider");
    assert.equal(commands.filter((entry) => entry.includes("node server.js")).length, starts);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.live("source sync removes deleted files and preserves ignored runtime data", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "boat-sync-" });
    const root = `${base}/root`;
    const incoming = `${base}/incoming`;
    const archive = `${base}/source.tar.gz`;
    const manifest = `${base}/source-files.json`;
    yield* fs.makeDirectory(`${root}/node_modules`, { recursive: true });
    yield* fs.makeDirectory(`${root}/.t3`, { recursive: true });
    yield* fs.makeDirectory(incoming);
    yield* fs.writeFileString(`${root}/.gitignore`, "node_modules/\n.t3/\n.env\n");
    yield* fs.writeFileString(`${root}/old.ts`, "old");
    yield* fs.writeFileString(`${root}/keep.ts`, "before");
    yield* fs.writeFileString(`${root}/node_modules/cache`, "dependency");
    yield* fs.writeFileString(`${root}/.t3/database`, "runtime");
    yield* fs.writeFileString(`${root}/.env`, "PRIVATE_SETTING=retained");
    yield* fs.writeFileString(`${incoming}/keep.ts`, "after");
    yield* fs.writeFileString(`${incoming}/new.ts`, "new");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const pack = spawner.exitCode(ChildProcess.make("tar", ["-czf", archive, "-C", incoming, "."]));
    const sync = spawner.exitCode(
      ChildProcess.make("sh", ["-c", sourceSyncScript, "boat-sync", archive, root, manifest]),
    );
    assert.equal(yield* pack, 0);
    assert.equal(yield* sync, 0);
    assert.isFalse(yield* fs.exists(`${root}/old.ts`));
    assert.equal(yield* fs.readFileString(`${root}/keep.ts`), "after");
    assert.equal(yield* fs.readFileString(`${root}/node_modules/cache`), "dependency");
    assert.equal(yield* fs.readFileString(`${root}/.t3/database`), "runtime");
    assert.equal(yield* fs.readFileString(`${root}/.env`), "PRIVATE_SETTING=retained");
    assert.equal(
      yield* spawner.exitCode(
        ChildProcess.make("git", ["-C", root, "ls-files", "--error-unmatch", "new.ts"]),
      ),
      0,
    );
    assert.notEqual(
      yield* spawner.exitCode(
        ChildProcess.make("git", ["-C", root, "ls-files", "--error-unmatch", "node_modules/cache"]),
      ),
      0,
    );
    yield* fs.remove(`${incoming}/new.ts`);
    assert.equal(yield* pack, 0);
    assert.equal(yield* sync, 0);
    assert.isFalse(yield* fs.exists(`${root}/new.ts`));
    assert.equal(yield* fs.readFileString(`${root}/node_modules/cache`), "dependency");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["ready", "failed"] as const)(
  "keeps the old snapshot until a persisted save settles as %s",
  (status) => {
    const test = setup();
    return Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        snapshot: "old-template",
      });
      yield* boat.operate({ action: "start", projectId, requestId: "first" });
      const pending = yield* boat.operate({ action: "snapshot", projectId, requestId: "first" });
      assert.equal(pending.projects[projectId]?.snapshot, "old-template");
      assert.deepEqual(pending.instances[0]?.savedSnapshot, {
        name: "crew-first",
        status: "saving",
      });
      const reopened = yield* make;
      const denied = yield* reopened
        .operate({ action: "snapshot", projectId, requestId: "first" })
        .pipe(Effect.flip);
      assert.equal(denied.category, "conflict");
      assert.equal(test.calls.filter((call) => call === "POST /saved-snapshots").length, 1);
      test.setSnapshotStatus(status);
      yield* reopened.reconcile();
      const settled = yield* reopened.read(projectId);
      assert.deepEqual(settled.instances[0]?.savedSnapshot, { name: "crew-first", status });
      assert.equal(
        settled.projects[projectId]?.snapshot,
        status === "ready" ? "crew-first" : "old-template",
      );
      const persisted = yield* (yield* make).read(projectId);
      assert.deepEqual(persisted.instances[0]?.savedSnapshot, { name: "crew-first", status });
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect("keeps a process installed while an older usage read is suspended", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = false;
    const test = setup((path) =>
      path.includes("/usage") && hold
        ? Effect.gen(function* () {
            hold = false;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          })
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, {
        ...DEFAULT_BOAT_PROJECT,
        enabled: true,
        devCommand: "npm run dev",
      });
      yield* boat.operate({ action: "start", projectId, requestId: "first" });
      hold = true;
      const reading = yield* boat.read(projectId).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* boat.operate({ action: "prepare", projectId, requestId: "first" });
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(reading)).instances[0]?.processId, 123);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }),
);

it.effect("keeps deletion ownership when an older read finishes", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = false;
    const test = setup((path) =>
      path.includes("/usage") && hold
        ? Effect.gen(function* () {
            hold = false;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          })
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      yield* boat.operate({ action: "start", projectId, requestId: "first" });
      hold = true;
      const reading = yield* boat.read(projectId).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* boat.operate({ action: "delete", projectId, requestId: "first" });
      yield* Deferred.succeed(release, undefined);
      const item = (yield* Fiber.join(reading)).instances[0];
      assert.equal(item?.deletionOperationId, "delete-test");
      assert.equal(item?.state, "deleted");
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }),
);

it.effect("reserves a request globally when two projects start together", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = false;
    const test = setup((path) =>
      path === "/limits" && hold
        ? Effect.gen(function* () {
            hold = false;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          })
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const boat = yield* make;
      const other = ProjectId.make("other-project");
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      for (const id of [projectId, other])
        yield* boat.configure(id, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      hold = true;
      const first = yield* boat
        .operate({ action: "start", projectId, requestId: "shared" })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* boat
        .operate({ action: "start", projectId: other, requestId: "shared" })
        .pipe(Effect.flip);
      assert.equal(second.category, "conflict");
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(first)));
      assert.equal(test.calls.filter((call) => call === "POST /sandboxes").length, 1);
      assert.equal((yield* boat.read()).instances.length, 1);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }),
);

it.effect.each(["capacity", "budget"] as const)(
  "reserves %s before a resume HTTP response",
  (constraint) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let hold = false;
      const test = setup((path) =>
        path.endsWith("/resume") && hold
          ? Effect.gen(function* () {
              hold = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            })
          : Effect.void,
      );
      yield* Effect.gen(function* () {
        const boat = yield* make;
        yield* boat.connect(Redacted.make("boat_fixture_private"));
        yield* boat.configure(projectId, {
          ...DEFAULT_BOAT_PROJECT,
          enabled: true,
          inheritDefaults: false,
          ttlMinutes: 120,
          maxConcurrent: 2,
          budgetUsd: 1,
        });
        for (const requestId of ["first", "second"]) {
          yield* boat.operate({ action: "start", projectId, requestId });
          yield* boat.operate({ action: "stop", projectId, requestId });
        }
        yield* boat.configure(projectId, {
          ...DEFAULT_BOAT_PROJECT,
          enabled: true,
          inheritDefaults: false,
          ttlMinutes: 120,
          maxConcurrent: constraint === "capacity" ? 1 : 2,
          budgetUsd: constraint === "budget" ? 0.1 : 1,
        });
        hold = true;
        const first = yield* boat
          .operate({ action: "resume", projectId, requestId: "first" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        test.setMachineState("archived");
        const second = yield* boat
          .operate({ action: "resume", projectId, requestId: "second" })
          .pipe(Effect.exit);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        assert.isTrue(Exit.isFailure(second));
        assert.equal(test.calls.filter((call) => call.endsWith("/resume")).length, 1);
      }).pipe(Effect.scoped, Effect.provide(test.services));
    }),
);

it.effect("replays unknown creation with the original parameters despite canStart false", () => {
  let lose = true;
  const bodies: unknown[] = [];
  const keys: (string | undefined)[] = [];
  const test = setup((path, method, body, key) => {
    if (path !== "/sandboxes" || method !== "POST") return Effect.void;
    bodies.push(body);
    keys.push(key);
    if (lose) {
      lose = false;
      return Effect.fail(new BoatError({ category: "provider" }));
    }
    return Effect.void;
  });
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
    yield* boat.operate({ action: "start", projectId, requestId: "first" }).pipe(Effect.exit);
    test.setCanStart(false);
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      ttlMinutes: 5,
      snapshot: "changed",
    });
    const reopened = yield* make;
    const result = yield* reopened.operate({ action: "start", projectId, requestId: "first" });
    assert.equal(result.instances[0]?.sandboxId, "bx_23456789");
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(keys, ["first", "first"]);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("treats an active resume retry as success without clearing the process or leases", () => {
  const test = setup((path) => {
    if (path.endsWith("/resume")) test.setMachineState("provisioned");
    return Effect.void;
  });
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      devCommand: "npm run dev",
    });
    yield* boat.operate({ action: "start", projectId, requestId: "first" }, ownerThreadId);
    yield* boat.operate({ action: "stop", projectId, requestId: "first" });
    test.setMachineState("archiving");
    const archiving = yield* boat
      .operate({ action: "resume", projectId, requestId: "first" }, ownerThreadId)
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(archiving));
    assert.equal(test.calls.filter((call) => call.endsWith("/resume")).length, 0);
    test.setMachineState("archived");
    const resumed = yield* boat.operate(
      { action: "resume", projectId, requestId: "first" },
      ownerThreadId,
    );
    assert.equal(resumed.instances[0]?.state, "idle");
    const lease = yield* boat.assertActiveLease(
      { requestId: "first", sandboxId: "bx_23456789" },
      ownerThreadId,
    );
    yield* lease.check;
    yield* boat.reconcile();
    assert.deepEqual((yield* boat.read(projectId)).instances[0]?.leases, [ownerThreadId]);
    assert.equal(test.calls.filter((call) => call.endsWith("/stop")).length, 1);
    yield* boat.operate({ action: "prepare", projectId, requestId: "first" });
    const before = (yield* boat.read(projectId)).instances[0];
    const result = yield* boat.operate({ action: "resume", projectId, requestId: "first" });
    assert.equal(test.calls.filter((call) => call.endsWith("/resume")).length, 1);
    assert.equal(result.instances[0]?.previewUrl, before?.previewUrl);
    assert.equal(result.instances[0]?.processId, 123);
    assert.deepEqual(result.instances[0]?.leases, [ownerThreadId]);
    test.setOwnerActive(false);
    yield* boat.reconcile();
    assert.equal((yield* boat.read(projectId)).instances[0]?.state, "archived");
    assert.equal(test.calls.filter((call) => call.endsWith("/stop")).length, 2);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("retains an unknown resume reservation and its idempotency key across restart", () => {
  let lose = true;
  const bodies: unknown[] = [];
  const keys: (string | undefined)[] = [];
  const test = setup((path, _method, body, key) => {
    if (!path.endsWith("/resume")) return Effect.void;
    bodies.push(body);
    keys.push(key);
    if (lose) {
      lose = false;
      test.setMachineState("archived");
      return Effect.fail(new BoatError({ category: "provider" }));
    }
    return Effect.void;
  });
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      inheritDefaults: false,
      maxConcurrent: 1,
    });
    for (const requestId of ["first", "second"]) {
      yield* boat.operate({ action: "start", projectId, requestId });
      yield* boat.operate({ action: "stop", projectId, requestId });
    }
    yield* boat.operate({ action: "resume", projectId, requestId: "first" }).pipe(Effect.exit);
    const reopened = yield* make;
    assert.equal((yield* reopened.read(projectId)).instances[0]?.state, "provisioning");
    const denied = yield* reopened
      .operate({ action: "resume", projectId, requestId: "second" })
      .pipe(Effect.flip);
    assert.equal(denied.category, "capacity");
    test.setCanStart(false);
    yield* reopened.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true, ttlMinutes: 5 });
    yield* reopened.operate({ action: "resume", projectId, requestId: "first" });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(keys[0], keys[1]);
    assert.isString(keys[0]);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("deduplicates an in-flight resume and replays its reservation after interruption", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const keys: (string | undefined)[] = [];
    let hold = true;
    const test = setup((path, _method, _body, key) => {
      if (!path.endsWith("/resume")) return Effect.void;
      keys.push(key);
      return hold
        ? Effect.gen(function* () {
            hold = false;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          })
        : Effect.void;
    });
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      yield* boat.operate({ action: "start", projectId, requestId: "first" }, ownerThreadId);
      yield* boat.operate({ action: "stop", projectId, requestId: "first" });
      const first = yield* boat
        .operate({ action: "resume", projectId, requestId: "first" }, ownerThreadId)
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      test.setMachineState("archived");
      const retry = yield* boat.operate({ action: "resume", projectId, requestId: "first" });
      assert.equal(keys.length, 1);
      assert.equal(retry.instances[0]?.state, "provisioning");
      assert.deepEqual(retry.instances[0]?.leases, [ownerThreadId]);
      yield* Fiber.interrupt(first);
      yield* boat.operate({ action: "resume", projectId, requestId: "first" });
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }),
);

it.effect("releases a definitively rejected resume reservation", () => {
  const test = setup((path) => {
    if (!path.endsWith("/resume")) return Effect.void;
    test.setMachineState("archived");
    return Effect.fail(new BoatError({ category: "provider", status: 400 }));
  });
  return Effect.gen(function* () {
    const boat = yield* make;
    yield* boat.connect(Redacted.make("boat_fixture_private"));
    yield* boat.configure(projectId, {
      ...DEFAULT_BOAT_PROJECT,
      enabled: true,
      inheritDefaults: false,
      maxConcurrent: 1,
    });
    yield* boat.operate({ action: "start", projectId, requestId: "first" });
    const stopped = yield* boat.operate({ action: "stop", projectId, requestId: "first" });
    const denied = yield* boat
      .operate({ action: "resume", projectId, requestId: "first" })
      .pipe(Effect.flip);
    assert.equal(denied.status, 400);
    const after = yield* boat.read(projectId);
    assert.equal(after.instances[0]?.state, "archived");
    assert.equal(after.instances[0]?.stoppedAt, stopped.instances[0]?.stoppedAt);
    yield* boat.operate({ action: "start", projectId, requestId: "second" });
    assert.equal(test.calls.filter((call) => call === "POST /sandboxes").length, 2);
  }).pipe(Effect.scoped, Effect.provide(test.services));
});

it.effect("keeps a completed create when a duplicate response rejects late", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const firstRelease = yield* Deferred.make<void>();
    const secondRelease = yield* Deferred.make<void>();
    let count = 0;
    const test = setup((path, method) => {
      if (path !== "/sandboxes" || method !== "POST") return Effect.void;
      return ++count === 1
        ? Effect.gen(function* () {
            yield* Deferred.succeed(firstEntered, undefined);
            yield* Deferred.await(firstRelease);
          })
        : Effect.gen(function* () {
            yield* Deferred.succeed(secondEntered, undefined);
            yield* Deferred.await(secondRelease);
            return yield* new BoatError({ category: "provider", status: 429 });
          });
    });
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      const first = yield* boat
        .operate({ action: "start", projectId, requestId: "first" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      const duplicate = yield* boat
        .operate({ action: "start", projectId, requestId: "first" })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(secondEntered);
      yield* Deferred.succeed(firstRelease, undefined);
      assert.equal((yield* Fiber.join(first)).instances[0]?.sandboxId, "bx_23456789");
      yield* Deferred.succeed(secondRelease, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(duplicate)));
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const stored = JSON.parse(yield* fs.readFileString(`${config.stateDir}/boat.json`));
      assert.equal(stored.instances[0].state, "ready");
      assert.equal(stored.instances[0].sandboxId, "bx_23456789");
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }),
);

it.effect.each([0.2, 0.1])(
  "reserves a full expired resume replay within budget %s",
  (budgetUsd) => {
    const keys: (string | undefined)[] = [];
    const bodies: unknown[] = [];
    const test = setup((path, _method, body, key) => {
      if (path.endsWith("/resume")) {
        keys.push(key);
        bodies.push(body);
      }
      return Effect.void;
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const boat = yield* make;
          yield* boat.connect(Redacted.make("boat_fixture_private"));
          yield* boat.configure(projectId, {
            ...DEFAULT_BOAT_PROJECT,
            enabled: true,
            inheritDefaults: false,
            ttlMinutes: 240,
            budgetUsd: 0.2,
          });
          yield* boat.operate({ action: "start", projectId, requestId: "first" });
          yield* boat.operate({ action: "stop", projectId, requestId: "first" });
          const stored = JSON.parse(yield* fs.readFileString(`${config.stateDir}/boat.json`));
          stored.projects[projectId].budgetUsd = budgetUsd;
          // Crash boundary: reservation committed, no HTTP request sent yet.
          stored.instances[0].state = "provisioning";
          stored.instances[0].resumeOperation = { id: "persisted-resume", ttlSeconds: 14400 };
          yield* fs.writeFileString(`${config.stateDir}/boat.json`, JSON.stringify(stored));
        }),
      );
      yield* TestClock.adjust("241 minutes");
      const reopened = yield* make;
      const result = yield* reopened
        .operate({ action: "resume", projectId, requestId: "first" })
        .pipe(Effect.exit);
      if (budgetUsd === 0.1) {
        assert.isTrue(Exit.isFailure(result));
        assert.equal(keys.length, 0);
      } else {
        assert.isTrue(Exit.isSuccess(result));
        if (Exit.isSuccess(result))
          assert.isAtLeast(
            Date.parse(result.value.instances[0]!.expiresAt),
            (yield* Clock.currentTimeMillis) + 14400000,
          );
        assert.deepEqual(keys, ["persisted-resume"]);
        assert.deepEqual(bodies, [{ ttlSeconds: 14400 }]);
        const stops = test.calls.filter((call) => call.endsWith("/stop")).length;
        yield* reopened.reconcile();
        assert.equal(test.calls.filter((call) => call.endsWith("/stop")).length, stops);
      }
    }).pipe(Effect.scoped, Effect.provide(test.services));
  },
);

it.effect("does not roll back a newer deletion when resume rejects late", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const test = setup((path) =>
      path.endsWith("/resume")
        ? Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* new BoatError({ category: "provider", status: 400 });
          })
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const boat = yield* make;
      yield* boat.connect(Redacted.make("boat_fixture_private"));
      yield* boat.configure(projectId, { ...DEFAULT_BOAT_PROJECT, enabled: true });
      yield* boat.operate({ action: "start", projectId, requestId: "first" });
      yield* boat.operate({ action: "stop", projectId, requestId: "first" });
      const resuming = yield* boat
        .operate({ action: "resume", projectId, requestId: "first" })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* boat.operate({ action: "delete", projectId, requestId: "first" });
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(resuming)));
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const stored = yield* decodeStoredInstances(
        yield* fs.readFileString(`${config.stateDir}/boat.json`),
      );
      assert.equal(stored.instances[0]?.state, "deleted");
      const state = yield* boat.read(projectId);
      assert.equal(state.instances[0]?.state, "deleted");
      assert.equal(state.instances[0]?.deletionOperationId, "delete-test");
    }).pipe(Effect.scoped, Effect.provide(test.services));
  }),
);
