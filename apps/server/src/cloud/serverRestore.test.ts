// @effect-diagnostics nodeBuiltinImport:off -- Exercise the real offline launcher against disposable installations.
// oxlint-disable t3code/no-global-process-runtime -- Native executable fixtures must match the host platform.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { vi } from "vite-plus/test";

import { readServiceState, writeServiceState } from "../serviceLauncher.ts";
import { acquireServiceLauncherLock } from "./serverRestoreControl.ts";
import {
  SERVER_RESTORE_MANIFEST,
  SERVER_RESTORE_PROFILE_CONTRACT,
  qualifyServerRestoreRuntime,
  serverRestoreFiles,
  serverRestoreIdentity,
  serverUpdateHold,
  verifyServerRestoreRuntime,
} from "./serverRestoreManifest.ts";
import { inspectServerRestore, preflightServerRestore } from "./serverRestoreStore.ts";
import {
  listServerRestore,
  releaseServerUpdateHold,
  restoreServerVersion,
} from "./serverRestore.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import { prunePinnedRuntimes } from "./pinnedRuntime.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  acquireServerRuntimeRetention,
  assertServerRuntimeCommitFits,
  cleanupServerRuntimeRetention,
} from "./serverRuntimeRetention.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const adapt = (command: string, args: ReadonlyArray<string>) =>
    process.platform === "win32" && command.endsWith("t3.exe")
      ? { command: process.execPath, args: [`${command}.cjs`, ...args] }
      : { command, args };
  const spawn = (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => {
    const target = adapt(command, args);
    return actual.spawn(target.command, target.args, options);
  };
  const execFile = (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.ExecFileOptions,
    callback: (
      error: NodeChildProcess.ExecFileException | null,
      stdout: string | Buffer,
      stderr: string | Buffer,
    ) => void,
  ) => {
    const target = adapt(command, args);
    return actual.execFile(target.command, target.args, options, callback);
  };
  return { ...actual, spawn, execFile };
});

async function fixture(baseDir: string, behavior: "ready" | "crash" = "ready") {
  const userdata = NodePath.join(baseDir, "userdata");
  await NodeFSP.mkdir(userdata, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(userdata, "environment-id"), "original-environment\n");
  await NodeFSP.writeFile(NodePath.join(userdata, "settings.json"), '{"profile":"original"}');
  await NodeFSP.writeFile(NodePath.join(userdata, "private-auth"), "original-auth");
  const dbPath = NodePath.join(userdata, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT); INSERT INTO effect_sql_migrations VALUES (1, 'Base'); CREATE TABLE orchestration_events (application_event_version INTEGER, payload_json TEXT); INSERT INTO orchestration_events VALUES (2, 'original chat');",
  );
  db.close();
  const identity = await serverRestoreIdentity(baseDir);
  const manifest = async (version: string, stagingDirectory?: string) => {
    const directory = stagingDirectory ?? NodePath.join(baseDir, "runtime", "versions", version);
    await NodeFSP.mkdir(directory, { recursive: true });
    const executable = NodePath.join(directory, process.platform === "win32" ? "t3.exe" : "t3");
    const source = `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (args[0] === "__service-preflight") {
  if (args[1] !== "--database-path" || args[2] !== ${JSON.stringify(dbPath)} || process.env.T3CODE_HOME !== ${JSON.stringify(baseDir)}) process.exit(4);
  console.log(JSON.stringify({ status: "ready", version: ${JSON.stringify(version)}, launcherProtocol: ${SERVICE_LAUNCHER_PROTOCOL} })); process.exit(0);
}
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  if (${JSON.stringify(behavior === "crash")} && ${JSON.stringify(version)} === "1.0.0") {
    fs.writeFileSync(${JSON.stringify(dbPath)}, "broken trial database"); process.exit(7);
  }
  fs.writeFileSync(${JSON.stringify(NodePath.join(baseDir, "trial-identity"))}, JSON.stringify({ home: process.env.T3CODE_HOME, token: process.env.RESTORE_TEST_VALUE }));
  process.send({ type: "prepared", updateId: context.update.id, restore: { installationId: ${JSON.stringify(identity.installationId)}, version: ${JSON.stringify(version)} } });
}
process.on("message", () => {});
`;
    await NodeFSP.writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    if (process.platform === "win32") await NodeFSP.writeFile(`${executable}.cjs`, source);
    await NodeFSP.writeFile(
      NodePath.join(directory, SERVER_RESTORE_MANIFEST),
      JSON.stringify({
        format: 1,
        version,
        sourceSha: "a".repeat(40),
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        profileContract: `${SERVER_RESTORE_PROFILE_CONTRACT}:${"c".repeat(64)}`,
        eventContract: "b".repeat(64),
        migrations: [{ id: 1, name: "Base" }],
        files: await serverRestoreFiles(directory),
      }),
    );
    await NodeFSP.writeFile(NodePath.join(directory, ".install-complete"), `${version}\n`);
    if (stagingDirectory === undefined) await qualifyServerRestoreRuntime(identity, version);
  };
  await manifest("1.0.0");
  await manifest("2.0.0");
  const statePath = NodePath.join(baseDir, "runtime", "service-state.json");
  await writeServiceState(statePath, {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: "2.0.0",
  });
  const candidate = (await inspectServerRestore(baseDir)).candidates[0]!;
  return {
    installRuntime: manifest,
    dbPath,
    statePath,
    identity,
    originalHash: (
      await verifyServerRestoreRuntime(
        NodePath.join(baseDir, "runtime", "versions", "2.0.0"),
        "2.0.0",
      )
    ).sha256,
    input: { version: "1.0.0", expectedCurrentVersion: "2.0.0", expectedHash: candidate.sha256 },
  };
}

it.layer(NodeServices.layer, { excludeTestServices: true })("offline server restore", (it) => {
  it.effect(
    "restores a retained runtime through trial readiness while keeping profile and hold",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-" });
        const setup = yield* Effect.promise(() => fixture(baseDir));
        yield* fs.writeFileString(
          NodePath.join(baseDir, "service.env"),
          "RESTORE_TEST_VALUE=preserved\n",
        );
        const listed = yield* listServerRestore({ baseDir });
        assert.equal(listed.candidates[0]?.blockedReason, null);
        assert.equal(listed.candidates[0]?.sourceSha, "a".repeat(40));
        const result = yield* restoreServerVersion({ baseDir, ...setup.input });
        assert.deepEqual(result, { status: "restored", version: "1.0.0", reason: null });
        assert.equal(
          (yield* listServerRestore({ baseDir })).installationId,
          setup.identity.installationId,
        );
        assert.isTrue(yield* Effect.promise(() => serverUpdateHold(baseDir)));
        assert.equal(
          yield* fs.readFileString(NodePath.join(baseDir, "userdata", "settings.json")),
          '{"profile":"original"}',
        );
        assert.equal(
          yield* fs.readFileString(NodePath.join(baseDir, "userdata", "private-auth")),
          "original-auth",
        );
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(NodePath.join(baseDir, "trial-identity"))),
          { home: baseDir, token: "preserved" },
        );
        assert.equal((yield* releaseServerUpdateHold({ baseDir })).updateHold, false);
        assert.deepEqual(
          yield* fs.readDirectory(NodePath.join(baseDir, "runtime", "db-backup")),
          [],
        );
      }),
  );

  it.effect("returns to the original runtime and database after a failing trial", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-failed-" });
      const setup = yield* Effect.promise(() => fixture(baseDir, "crash"));
      const result = yield* restoreServerVersion({ baseDir, ...setup.input });
      assert.equal(result.status, "failed");
      assert.equal(result.version, "2.0.0");
      assert.isFalse(yield* Effect.promise(() => serverUpdateHold(baseDir)));
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(setup.dbPath, { readOnly: true });
        try {
          assert.equal(
            db.prepare("SELECT payload_json FROM orchestration_events").get()?.payload_json,
            "original chat",
          );
        } finally {
          db.close();
        }
      });
      assert.equal(
        (yield* Effect.promise(() => readServiceState(setup.statePath))).update?.status,
        "rolled-back",
      );
    }),
  );

  it.effect(
    "recovers a durably pending restore after interruption without replacing its backup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-recovery-" });
        const setup = yield* Effect.promise(() => fixture(baseDir));
        const backup = NodePath.join(baseDir, "runtime", "db-backup", "interrupted-restore");
        yield* fs.makeDirectory(backup, { recursive: true });
        yield* fs.copyFile(setup.dbPath, NodePath.join(backup, "database"));
        yield* Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(setup.dbPath);
          try {
            db.exec("UPDATE orchestration_events SET payload_json='interrupted trial data'");
          } finally {
            db.close();
          }
        });
        yield* Effect.promise(() =>
          writeServiceState(setup.statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "2.0.0",
            update: {
              id: "interrupted-restore",
              fromVersion: "2.0.0",
              targetVersion: "1.0.0",
              dbPath: setup.dbPath,
              status: "pending",
              restore: {
                installationId: setup.identity.installationId,
                expectedHash: setup.input.expectedHash,
                originalHash: setup.originalHash,
                previousHold: false,
              },
            },
          }),
        );
        const result = yield* restoreServerVersion({ baseDir, ...setup.input });
        assert.equal(result.status, "failed");
        assert.equal(result.version, "2.0.0");
        assert.isFalse(yield* fs.exists(backup));
        assert.isFalse((yield* listServerRestore({ baseDir })).updateHold);
        assert.isFalse(yield* fs.exists(NodePath.join(baseDir, "trial-identity")));
        yield* Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(setup.dbPath, { readOnly: true });
          try {
            assert.equal(
              db.prepare("SELECT payload_json FROM orchestration_events").get()?.payload_json,
              "original chat",
            );
          } finally {
            db.close();
          }
        });
      }),
  );

  it.effect(
    "fails closed before handoff for a changed hash, ledger name, event version or capacity",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-blocked-" });
        const setup = yield* Effect.promise(() => fixture(baseDir));
        yield* Effect.promise(async () => {
          await expect(
            preflightServerRestore(
              baseDir,
              { ...setup.input, expectedHash: "0".repeat(64) },
              process.env,
            ),
          ).rejects.toThrow();
          const db = new NodeSqlite.DatabaseSync(setup.dbPath);
          try {
            db.exec("UPDATE effect_sql_migrations SET name='DifferentSchema'");
            assert.include(
              (await inspectServerRestore(baseDir)).candidates[0]?.blockedReason ?? "",
              "migration names",
            );
            db.exec(
              "UPDATE effect_sql_migrations SET name='Base'; UPDATE orchestration_events SET application_event_version=3",
            );
            assert.include(
              (await inspectServerRestore(baseDir)).candidates[0]?.blockedReason ?? "",
              "event contract",
            );
            db.exec("UPDATE orchestration_events SET application_event_version=2");
          } finally {
            db.close();
          }
          const manifestPath = NodePath.join(
            baseDir,
            "runtime",
            "versions",
            "1.0.0",
            SERVER_RESTORE_MANIFEST,
          );
          const originalManifest = await NodeFSP.readFile(manifestPath, "utf8");
          for (const change of [
            { eventContract: "d".repeat(64) },
            { profileContract: `${SERVER_RESTORE_PROFILE_CONTRACT}:${"e".repeat(64)}` },
          ]) {
            await NodeFSP.writeFile(
              manifestPath,
              JSON.stringify({ ...JSON.parse(originalManifest), ...change }),
            );
            assert.include(
              (await inspectServerRestore(baseDir)).candidates[0]?.blockedReason ?? "",
              "event or profile contract",
            );
          }
          await NodeFSP.writeFile(manifestPath, originalManifest);
          await NodeFSP.writeFile(
            NodePath.join(baseDir, "runtime", "restore-limits.json"),
            JSON.stringify({ maxVersions: 2, maxBytes: 1 }),
          );
          await expect(preflightServerRestore(baseDir, setup.input, process.env)).rejects.toThrow(
            /limit/,
          );
          assert.equal((await readServiceState(setup.statePath)).update, undefined);
          assert.isFalse(await serverUpdateHold(baseDir));
        });
      }),
  );

  it.effect("detects modified retained files and never takes over a live launcher lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-tampered-" });
      const setup = yield* Effect.promise(() => fixture(baseDir));
      yield* Effect.promise(async () => {
        const release = await acquireServiceLauncherLock(baseDir);
        try {
          await expect(acquireServiceLauncherLock(baseDir)).rejects.toThrow();
        } finally {
          release();
        }
        const directory = NodePath.join(baseDir, "runtime", "versions", "1.0.0");
        await NodeFSP.appendFile(
          NodePath.join(directory, process.platform === "win32" ? "t3.exe" : "t3"),
          "modified",
        );
        await expect(verifyServerRestoreRuntime(directory, "1.0.0")).rejects.toThrow(/checksum/);
        await expect(preflightServerRestore(baseDir, setup.input, process.env)).rejects.toThrow();
      });
    }),
  );

  it.effect("keeps the qualified predecessor while pruning an older unused runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-retention-" });
      yield* Effect.promise(() => fixture(baseDir));
      const versions = NodePath.join(baseDir, "runtime", "versions");
      yield* fs.makeDirectory(NodePath.join(versions, "0.5.0"));
      yield* fs.writeFileString(NodePath.join(versions, "0.5.0", ".install-complete"), "0.5.0\n");
      for (const version of ["0.5.0", "1.0.0", "2.0.0"]) {
        yield* Effect.promise(() =>
          NodeFSP.utimes(
            NodePath.join(versions, version, ".install-complete"),
            new Date(0),
            new Date(0),
          ),
        );
      }
      const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
        Effect.provide(ProcessRunner.layer),
      );
      assert.deepEqual(removed, ["0.5.0"]);
      assert.isTrue(yield* fs.exists(NodePath.join(versions, "1.0.0")));
    }),
  );

  it.effect("retains the current runtime and predecessor immediately after repeated commits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-hard-retention-" });
      const setup = yield* Effect.promise(() => fixture(baseDir));
      yield* Effect.promise(async () => {
        const versions = NodePath.join(baseDir, "runtime", "versions");
        const maxBytes = (await inspectServerRestore(baseDir)).totalBytes * 4;
        await NodeFSP.writeFile(
          NodePath.join(baseDir, "runtime", "restore-limits.json"),
          JSON.stringify({ maxVersions: 2, maxBytes }),
        );
        for (const target of [3, 4, 5, 6]) {
          const version = `${target}.0.0`;
          const nextState = {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: version,
            update: {
              id: `update-${target}`,
              fromVersion: `${target - 1}.0.0`,
              targetVersion: version,
              status: "committed",
            },
          } as const;
          const retention = await acquireServerRuntimeRetention(baseDir);
          try {
            await retention.admit(version);
            const staging = await NodeFSP.mkdtemp(NodePath.join(versions, ".staging-"));
            await retention.reserve(version, staging);
            await setup.installRuntime(version, staging);
            await retention.check(0);
            const during = await inspectServerRestore(baseDir);
            assert.isAtMost(during.totalBytes, maxBytes);
            assert.include(during.unavailableReason ?? "", "limit");
            await NodeFSP.rename(staging, NodePath.join(versions, version));
          } finally {
            retention.release();
          }
          await assertServerRuntimeCommitFits(baseDir, nextState);
          await writeServiceState(setup.statePath, nextState);
          await qualifyServerRestoreRuntime(setup.identity, version);
          await cleanupServerRuntimeRetention(baseDir);
          const inventory = await inspectServerRestore(baseDir);
          assert.equal(inventory.currentVersion, version);
          assert.equal(inventory.unavailableReason, null);
          assert.isAtMost(inventory.totalBytes, maxBytes);
          assert.deepEqual(await NodeFSP.readdir(versions), [`${target - 1}.0.0`, version]);
          assert.equal(inventory.candidates[0]?.version, `${target - 1}.0.0`);
          assert.equal(inventory.candidates[0]?.blockedReason, null);
        }
      });
    }),
  );

  it.effect("counts archive and unknown staging bytes and refuses a second transaction slot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-peak-" });
      yield* Effect.promise(() => fixture(baseDir));
      yield* Effect.promise(async () => {
        const initial = await inspectServerRestore(baseDir);
        const maxBytes = initial.totalBytes + 1024;
        await NodeFSP.writeFile(
          NodePath.join(baseDir, "runtime", "restore-limits.json"),
          JSON.stringify({ maxVersions: 2, maxBytes }),
        );
        const retention = await acquireServerRuntimeRetention(baseDir);
        try {
          await expect(acquireServerRuntimeRetention(baseDir)).rejects.toThrow();
          await retention.admit("3.0.0");
          const staging = await NodeFSP.mkdtemp(
            NodePath.join(baseDir, "runtime", "versions", ".staging-"),
          );
          await retention.reserve("3.0.0", staging);
          await NodeFSP.writeFile(NodePath.join(staging, "t3-runtime-archive"), Buffer.alloc(1024));
          assert.equal((await inspectServerRestore(baseDir)).totalBytes, maxBytes);
          await expect(retention.check(1)).rejects.toThrow(/limit/);
          await expect(retention.admit("4.0.0")).rejects.toThrow(/reserved/);
          const unknown = NodePath.join(baseDir, "runtime", "versions", ".staging-unknown");
          await NodeFSP.mkdir(unknown);
          await expect(retention.check(0)).rejects.toThrow(/limit/);
          assert.isTrue((await NodeFSP.stat(unknown)).isDirectory());
        } finally {
          retention.release();
        }
      });
    }),
  );

  it.effect("reclaims only recorded abandoned staging and verified orphan runtimes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-orphans-" });
      const setup = yield* Effect.promise(() => fixture(baseDir));
      yield* Effect.promise(async () => {
        const versions = NodePath.join(baseDir, "runtime", "versions");
        await setup.installRuntime("0.5.0");
        const owned = await NodeFSP.mkdtemp(NodePath.join(versions, ".staging-"));
        await NodeFSP.writeFile(NodePath.join(owned, "t3-runtime-archive"), "owned archive");
        await NodeFSP.writeFile(
          NodePath.join(baseDir, "runtime", "install-candidate.json"),
          JSON.stringify({ version: "3.0.0", directory: owned, pid: 2_147_483_647 }),
        );
        const unknown = NodePath.join(versions, ".staging-unknown");
        await NodeFSP.mkdir(unknown);
        await NodeFSP.writeFile(NodePath.join(unknown, "uncertain"), "preserved");
        const retention = await acquireServerRuntimeRetention(baseDir);
        try {
          await expect(retention.admit("4.0.0")).rejects.toThrow(/limit/);
          assert.deepEqual((await NodeFSP.readdir(versions)).sort(), [
            ".staging-unknown",
            "1.0.0",
            "2.0.0",
          ]);
          assert.equal(
            await NodeFSP.readFile(NodePath.join(unknown, "uncertain"), "utf8"),
            "preserved",
          );
        } finally {
          retention.release();
        }
      });
    }),
  );

  it.effect.each(["process", "launcher", "pending"] as const)(
    "preserves %s references before refusing an update",
    (reference) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-references-" });
        const setup = yield* Effect.promise(() => fixture(baseDir));
        yield* Effect.promise(async () => {
          const versions = NodePath.join(baseDir, "runtime", "versions");
          const executable = NodePath.join(
            versions,
            "1.0.0",
            process.platform === "win32" ? "t3.exe" : "t3",
          );
          const originalReadlink = NodeFSP.readlink;
          using _processReference =
            reference === "process" && process.platform === "linux"
              ? vi
                  .spyOn(NodeFSP, "readlink")
                  .mockImplementation((async (path: Parameters<typeof NodeFSP.readlink>[0]) =>
                    path === `/proc/${process.pid}/exe`
                      ? executable
                      : originalReadlink(path)) as typeof NodeFSP.readlink)
              : undefined;
          if (
            reference === "launcher" ||
            (reference === "process" && process.platform !== "linux")
          ) {
            const launcher = NodePath.join(
              baseDir,
              process.platform === "win32" ? "retained.cmd" : "retained",
            );
            if (process.platform === "win32")
              await NodeFSP.writeFile(launcher, `@echo off\r\n"${executable}" %*`);
            else await NodeFSP.symlink(executable, launcher);
            await NodeFSP.writeFile(
              NodePath.join(baseDir, "runtime", "launchers"),
              `${launcher}\n`,
            );
          }
          if (reference === "pending") {
            await setup.installRuntime("3.0.0");
            await writeServiceState(setup.statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "2.0.0",
              update: {
                id: "pending",
                fromVersion: "2.0.0",
                targetVersion: "3.0.0",
                dbPath: setup.dbPath,
                status: "pending",
              },
            });
          }
          const retention = await acquireServerRuntimeRetention(baseDir);
          try {
            await expect(retention.admit("4.0.0")).rejects.toThrow(/slot|transaction/);
            assert.deepEqual(
              (await NodeFSP.readdir(versions)).sort(),
              reference === "pending" ? ["1.0.0", "2.0.0", "3.0.0"] : ["1.0.0", "2.0.0"],
            );
          } finally {
            retention.release();
          }
        });
      }),
  );
});
