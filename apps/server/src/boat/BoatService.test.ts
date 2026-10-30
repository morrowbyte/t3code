import { assert, it } from "@effect/vitest";
import { DEFAULT_BOAT_PROJECT, BoatInstance, ProjectId, ThreadId, RunId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { BoatApi } from "./BoatApi.ts";
import { make, sourceSyncScript } from "./BoatService.ts";

const decodeInstance = Schema.decodeUnknownEffect(BoatInstance);
const projectId = ProjectId.make("project-boat");
const ownerThreadId = ThreadId.make("thread-boat");
function setup(
  onCall: (path: string, method: string, body?: unknown) => Effect.Effect<unknown> = () =>
    Effect.void,
  threadId = ownerThreadId,
) {
  const calls: string[] = [];
  let machineState = "ready";
  let snapshotStatus = "saving";
  let workspaceRoot = process.cwd();
  let ownerActive = true;
  let projectExists = true;
  let archiveBytes = new Uint8Array();
  const api = Layer.succeed(BoatApi, {
    request: (_key, path, method = "GET", body) =>
      Effect.sync(() => {
        calls.push(`${method} ${path}`);
        if (path === "/limits")
          return {
            canStart: true,
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
          return { processId: 123, exitCode: 0 };
        }
        if (path.endsWith("/desktop?vnc=1"))
          return { desktopUrl: "https://preview.example.test/android" };
        if (path.includes("/usage")) return { dollars: 0.01 };
        if (method === "DELETE" || path.startsWith("/deletion-operations/"))
          return { operation: { id: "delete-test", status: "completed" } };
        if (path.endsWith("/stop")) machineState = "archived";
        if (path.endsWith("/resume")) machineState = "ready";
        return { sandbox: { id: "bx_23456789", state: machineState } };
      }).pipe(Effect.tap(() => onCall(path, method, body))),
  });
  const base = ServerConfig.layerTest(process.cwd(), { prefix: "boat-service-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const services = Layer.mergeAll(
    api,
    Layer.mock(PreviewManager)({
      list: () => Effect.succeed({ sessions: [] } as never),
      open: () => Effect.succeed({ tabId: "setup-preview" } as never),
      close: () => Effect.void,
    }),
    Layer.mock(ProjectionStoreV2)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === threadId
            ? {
                ...liveThreadShell(id),
                projectId,
                activeRunId: ownerActive ? RunId.make("run-boat") : null,
                activityRunStatus: null,
              }
            : null,
        ),
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
          execute: ({ args }) =>
            Effect.gen(function* () {
              if (args[0] === "archive") {
                yield* fs.writeFile(args[args.indexOf("--output") + 1]!, archiveBytes);
              }
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "tree",
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
    services,
    setSnapshotStatus: (status: string) => {
      snapshotStatus = status;
    },
    setArchive: (bytes: Uint8Array) => {
      archiveBytes = new Uint8Array(bytes);
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
      yield* boat.operate({ action: "start", projectId, requestId: "first" });
      const reopened = yield* make;
      const state = yield* reopened.operate({ action: "start", projectId, requestId: "first" });
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
      yield* reopened.operate({ action: "stop", projectId, requestId: "first" });
      yield* reopened.operate({ action: "delete", projectId, requestId: "first" });
      yield* reopened.disconnect;
      assert.isFalse((yield* reopened.read()).configured);
    }).pipe(Effect.provide(test.services), Effect.scoped);
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
  }).pipe(Effect.provide(test.services), Effect.scoped);
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
    assert.equal(configured.projects[projectId]!.devCommand, "vp run dev");
    yield* boat.operate({ action: "start", projectId, requestId: "android" });
    yield* boat.operate({
      action: "exec",
      projectId,
      requestId: "android",
      command: "cat restored.txt",
    });
    assert.deepEqual(execBody, {
      command: "mkdir -p /home/user/crew && cd /home/user/crew || exit\ncat restored.txt",
      timeoutSeconds: 20,
    });
    const preview = yield* boat.operate({ action: "preview", projectId, requestId: "android" });
    assert.equal(preview.instances[0]?.previewUrl, "https://preview.example.test/android");
    assert.include(test.calls, "POST /sandboxes/bx_23456789/desktop?vnc=1");
  }).pipe(Effect.provide(test.services), Effect.scoped);
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
  }).pipe(Effect.provide(test.services), Effect.scoped);
});

it.effect("renews active agent leases and stops after the last owner finishes", () =>
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
      test.setOwnerActive(false);
      yield* boat.reconcile();
      assert.include(test.calls, "PATCH /sandboxes/bx_23456789");
      assert.include(test.calls, "POST /sandboxes/bx_23456789/stop");
    }).pipe(Effect.provide(test.services), Effect.scoped);
  }),
);

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
  }).pipe(Effect.provide(test.services), Effect.scoped);
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
  }).pipe(Effect.provide(test.services), Effect.scoped);
});

it.effect("uploads source archives in bounded chunks and assembles them before setup", () => {
  const uploads: { path: string; content: string }[] = [];
  let command = "";
  const test = setup((path, method, body) =>
    Effect.sync(() => {
      if (path.endsWith("/files") && method === "PUT")
        uploads.push(body as (typeof uploads)[number]);
      if (path.endsWith("/commands")) command = (body as { command: string }).command;
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
    const firstProcessId = (yield* boat.read(projectId)).instances[0]!.processId;
    yield* boat.operate({ action: "prepare", projectId, requestId: "chunks" });
    assert.equal((yield* boat.read(projectId)).instances[0]!.processId, firstProcessId);
    assert.notInclude(command, "node server.js");
  }).pipe(Effect.provide(test.services), Effect.scoped);
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
    }).pipe(Effect.provide(test.services), Effect.scoped);
  },
);
