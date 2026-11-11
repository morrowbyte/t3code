// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real temporary install artifacts and read-only SQLite compatibility checks.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import {
  desktopRestoreControllerRuntime,
  type DesktopRestoreControllerRuntime,
} from "./desktopRestoreController.ts";
import {
  saveDesktopRestoreLaunchContext,
  readDesktopRestoreLaunchContext,
} from "./desktopRestoreGraphics.ts";
import {
  desktopRestoreArtifactPath,
  desktopRestoreDirectory,
  desktopRestoreFileDigest,
  desktopRestoreProcessIdentity,
  isDesktopUpdateHeld,
  listDesktopRestores,
  markDesktopRestoreHealthy,
  readDesktopRestoreRegistry,
  readDesktopRestoreTransaction,
  registerDesktopRestoreBuild,
  releaseDesktopUpdateHold,
  restoreDesktopVersion,
  runDesktopRestoreController,
  recoverDesktopRestoreBeforeStartup,
  writeDesktopRestoreJson,
  type DesktopRestoreBuild,
  type DesktopRestoreIdentity,
  type DesktopRestoreProcess,
} from "./desktopRestore.ts";

const fingerprint = "a".repeat(64);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    link: vi.fn(actual.link),
    unlink: vi.fn(actual.unlink),
  };
});
const build = (version: string): DesktopRestoreBuild => ({
  protocol: 1,
  version,
  sourceSha: "b".repeat(40),
  database: fingerprint,
  events: fingerprint,
  profile: fingerprint,
  updateHold: true,
});

async function readReceipt(file: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const inspect = async () => {
      try {
        const receipt = JSON.parse(await NodeFSP.readFile(file, "utf8")) as Record<string, unknown>;
        watcher.close();
        resolve(receipt);
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return;
        watcher.close();
        reject(cause);
      }
    };
    const watcher = NodeFS.watch(NodePath.dirname(file), () => {
      void inspect();
    });
    watcher.once("error", reject);
    void inspect();
  });
}

async function startRestoreLockOwner(recovery: string | null = null) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const childProcess = require("node:child_process");
if (process.argv[1]) {
  const fd = fs.openSync(process.argv[1], fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  const result = childProcess.spawnSync("flock", ["-n", "3"], {
    stdio: ["ignore", "ignore", "ignore", fd],
  });
  if (result.status !== 0) process.exit(2);
}
process.stdout.write("locked\\n");
process.stdin.resume();
`,
      ...(recovery === null ? [] : [recovery]),
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("close", (_code, signal) => resolve(signal)),
  );
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      const killed = child.kill("SIGKILL");
      const signal = await exited;
      if (killed) expect(signal).toBe("SIGKILL");
    }
    await exited;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Restore lock fixture exited before readiness.")));
      child.stdout.once("data", (data: Buffer) => {
        if (data.toString() === "locked\n") resolve();
        else reject(new Error("Restore lock fixture did not acquire its kernel mutex."));
      });
    });
    const identity = await desktopRestoreProcessIdentity(child.pid!);
    if (identity === null) throw new Error("Restore lock fixture lost its process identity.");
    return { identity, stop, [Symbol.asyncDispose]: stop };
  } catch (cause) {
    await stop();
    throw cause;
  }
}

async function setup(
  withDesktopProcess = false,
  desktopEnvironment: NodeJS.ProcessEnv = {},
  passwordStore: string | null = null,
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crew-desktop-restore-"));
  const baseDir = NodePath.join(directory, "home");
  const stateDir = NodePath.join(baseDir, "userdata");
  const userDataDir = NodePath.join(directory, "config", "t3code-nightly");
  const installPath = NodePath.join(directory, "Crew.AppImage");
  await NodeFSP.mkdir(stateDir, { recursive: true });
  await NodeFSP.mkdir(userDataDir, { recursive: true });
  const graphicsDirectory = NodePath.join(directory, "graphics");
  await NodeFSP.mkdir(graphicsDirectory, { mode: 0o700 });
  const graphics = NodeNet.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    graphics.once("error", reject);
    graphics.listen(NodePath.join(graphicsDirectory, "wayland-0"), resolve);
  });
  const desktopScript = NodePath.join(directory, "desktop.cjs");
  if (withDesktopProcess)
    await NodeFSP.writeFile(
      desktopScript,
      `
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const version = process.argv[2];
const profile = ${JSON.stringify(userDataDir)};
const lock = path.join(profile, "SingletonLock");
const receipt = (name, value) => {
  const file = path.join(profile, name + "-" + version + ".json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(value));
  fs.renameSync(file + ".tmp", file);
};
const server = net.createServer(socket => socket.end());
server.once("error", () => {
  receipt("started", { acquired: false });
  process.exit(2);
});
server.listen(path.join(profile, "singleton"), () => {
  fs.symlinkSync(os.hostname() + "-" + process.pid, lock);
  receipt("started", {
    acquired: true,
    pid: process.pid,
    home: process.env.T3CODE_HOME,
    profileId: process.env.T3CODE_DESKTOP_PROFILE,
    config: process.env.XDG_CONFIG_HOME,
    wayland: process.env.WAYLAND_DISPLAY,
    runtime: process.env.XDG_RUNTIME_DIR,
    desktop: process.env.XDG_CURRENT_DESKTOP,
    kde: process.env.KDE_SESSION_VERSION,
    passwordStore: process.argv.slice(3),
    nixDataDir: process.env.T3CODE_NIX_DATA_DIR,
    nixLauncher: process.env.T3CODE_NIX_LAUNCHER,
  });
});
process.once("SIGTERM", () => server.close(() => {
  fs.unlinkSync(lock);
  receipt("exited", { pid: process.pid });
  process.exit(0);
}));
`,
    );
  const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "statev2.sqlite"));
  db.exec(
    "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO effect_sql_migrations VALUES (1, 'initial'); CREATE TABLE chats (body TEXT); INSERT INTO chats VALUES ('retain this chat')",
  );
  db.close();
  await NodeFSP.writeFile(NodePath.join(stateDir, "environment-id"), "fixture-environment");
  await NodeFSP.writeFile(NodePath.join(userDataDir, "auth-token"), "fixture-auth");
  const identity: DesktopRestoreIdentity = {
    kind: "appimage",
    installPath,
    baseDir,
    stateDir,
    userDataDir,
    profileId: "nightly",
    environmentId: "fixture-environment",
    launcherPath: installPath,
    updaterPath: null,
    nixDataDir: null,
  };
  const install = async (version: string, metadata = build(version)) => {
    const mount = NodePath.join(directory, `mount-${version}`);
    await NodeFSP.mkdir(mount, { recursive: true });
    const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    await NodeFSP.writeFile(
      NodePath.join(mount, "t3code"),
      `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 9\nif [ "$2" = '--crew-desktop-restore-probe' ]; then\nprintf '%s\\n' '${JSON.stringify(metadata)}'\nfi\n`,
      { mode: 0o755 },
    );
    const mounter = `process.stdout.write(${JSON.stringify(`${mount}\n`)}); setInterval(() => {}, 2147483647);`;
    await NodeFSP.writeFile(
      installPath,
      `#!/bin/sh\nif [ "$1" = '--appimage-mount' ]; then\nexec ${shellWord(process.execPath)} -e ${shellWord(mounter)}\nfi\n${withDesktopProcess ? `exec ${shellWord(process.execPath)} ${shellWord(desktopScript)} ${shellWord(version)} "$@"` : "exit 2"}\n`,
      { mode: 0o755 },
    );
    await registerDesktopRestoreBuild({ baseDir, identity, build: metadata });
    const { kind, ...fields } = identity;
    await markDesktopRestoreHealthy({ baseDir, identity: { ...fields, kind }, build: metadata });
  };
  await install("1.0.0");
  await install("1.0.1");
  const registry = await readDesktopRestoreRegistry(baseDir);
  await saveDesktopRestoreLaunchContext({
    baseDir,
    installationId: registry.installationId,
    passwordStore,
    environment: {
      XDG_CONFIG_HOME: NodePath.dirname(userDataDir),
      XDG_RUNTIME_DIR: graphicsDirectory,
      WAYLAND_DISPLAY: "wayland-0",
      PRIVATE_TOKEN: "never-copy-this",
      ...desktopEnvironment,
    },
  });
  const state = await listDesktopRestores({ baseDir });
  const input = {
    baseDir,
    version: "1.0.0",
    expectedCurrentVersion: "1.0.1",
    expectedHash: state.candidates[0]!.sha256,
  };
  const quiesce = vi.fn(async () => {});
  const launch = vi.fn(async () => {});
  const health = vi.fn<DesktopRestoreControllerRuntime["health"]>(async () => {});
  return {
    baseDir,
    identity,
    install,
    input,
    quiesce,
    launch,
    health,
    graphicsDirectory,
    async changeGraphicsSession() {
      await new Promise<void>((resolve) => graphics.close(() => resolve()));
      const directory = `${graphicsDirectory}-recovery`;
      await NodeFSP.mkdir(directory, { mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        graphics.once("error", reject);
        graphics.listen(NodePath.join(directory, "wayland-0"), resolve);
      });
      return directory;
    },
    runtime: { prepare: desktopRestoreControllerRuntime.prepare, quiesce, launch, health },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => graphics.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

describe("bounded desktop restore", () => {
  it("restores the actual retained artifact and retains profile, chats and the update hold", async () => {
    await using fixture = await setup();
    const initial = await listDesktopRestores(fixture.input);
    expect(initial.candidates[0]!.blockedReason).toBeNull();
    expect(initial.maxVersions).toBe(2);
    expect(await restoreDesktopVersion(fixture.input)).toMatchObject({ status: "scheduled" });
    const transaction = await readDesktopRestoreTransaction(fixture.baseDir);
    await runDesktopRestoreController(
      { baseDir: fixture.baseDir, transactionId: transaction!.id },
      fixture.runtime,
    );
    expect((await desktopRestoreFileDigest(fixture.identity.installPath)).sha256).toBe(
      fixture.input.expectedHash,
    );
    expect((await listDesktopRestores(fixture.input)).currentVersion).toBe("1.0.0");
    expect(await isDesktopUpdateHeld(fixture.input)).toBe(true);
    expect(
      await NodeFSP.readFile(NodePath.join(fixture.identity.userDataDir, "auth-token"), "utf8"),
    ).toBe("fixture-auth");
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(fixture.identity.stateDir, "statev2.sqlite"),
      { readOnly: true },
    );
    try {
      expect(db.prepare("SELECT body FROM chats").get()?.body).toBe("retain this chat");
    } finally {
      db.close();
    }
    expect(fixture.health).toHaveBeenCalledWith(
      fixture.baseDir,
      expect.anything(),
      "1.0.0",
      fixture.input.expectedHash,
    );
    expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
    expect((await releaseDesktopUpdateHold(fixture.input)).updateHold).toBe(false);
    await fixture.install("1.0.2");
    const upgraded = await listDesktopRestores({ baseDir: fixture.baseDir });
    expect(upgraded.candidates.map((candidate) => candidate.version)).toEqual(["1.0.0"]);
  });

  it("treats a process disappearing during its identity read as stopped", async () => {
    vi.mocked(NodeFSP.readFile).mockRejectedValueOnce(
      Object.assign(new Error("Process exited"), { code: "ESRCH" }),
    );
    expect(await desktopRestoreProcessIdentity(1)).toBeNull();
  });

  it.each(["publish", "unlink"] as const)(
    "retries an interrupted owner %s without retaining its lock",
    async (phase) => {
      await using fixture = await setup();
      const lock = NodePath.join(desktopRestoreDirectory(fixture.baseDir), "mutation.lock");
      const identity = await desktopRestoreProcessIdentity(process.pid);
      let attempted = false;
      if (phase === "publish") {
        vi.mocked(NodeFSP.link).mockImplementationOnce(async (source, destination) => {
          expect(destination).toBe(lock);
          expect(await NodeFSP.readFile(source, "utf8")).toBe(identity);
          expect((await NodeFSP.stat(source)).mode & 0o777).toBe(0o600);
          attempted = true;
          throw new Error("interrupted owner publication");
        });
      } else {
        vi.mocked(NodeFSP.unlink).mockImplementationOnce(async (file) => {
          expect(NodePath.basename(String(file))).toMatch(/^\.mutation-owner-/);
          attempted = true;
          throw new Error("interrupted owner publication");
        });
      }
      await expect(releaseDesktopUpdateHold(fixture.input)).rejects.toThrow(
        "interrupted owner publication",
      );
      expect(attempted).toBe(true);
      await expect(NodeFSP.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await releaseDesktopUpdateHold(fixture.input)).updateHold).toBe(false);
      expect(
        (await NodeFSP.readdir(desktopRestoreDirectory(fixture.baseDir))).filter((name) =>
          name.startsWith(".mutation-owner-"),
        ),
      ).toEqual([]);
    },
  );

  it.each(["contents", "mode", "symlink"] as const)(
    "preserves an unknown private owner reservation: %s",
    async (kind) => {
      await using fixture = await setup();
      await using owner = await startRestoreLockOwner();
      const file = NodePath.join(
        desktopRestoreDirectory(fixture.baseDir),
        `.mutation-owner-${owner.identity.replace(":", "-")}-00000000-0000-4000-8000-000000000001`,
      );
      const target = NodePath.join(fixture.identity.userDataDir, "auth-token");
      const original = await NodeFSP.readFile(target, "utf8");
      if (kind === "symlink") await NodeFSP.symlink(target, file);
      else
        await NodeFSP.writeFile(file, kind === "contents" ? "unowned" : owner.identity, {
          mode: kind === "mode" ? 0o640 : 0o600,
        });
      const before = await NodeFSP.lstat(file);
      await owner.stop();
      expect((await releaseDesktopUpdateHold(fixture.input)).updateHold).toBe(false);
      expect((await NodeFSP.lstat(file)).ino).toBe(before.ino);
      expect(await NodeFSP.readFile(target, "utf8")).toBe(original);
    },
  );

  it.each([
    "reserved",
    "partial",
    "copied",
    "unpublishedOwner",
    "orphanRecovery",
    "heldRecovery",
  ] as const)("cleans interrupted staging before normal startup: %s", async (phase) => {
    await using fixture = await setup();
    const registry = await readDesktopRestoreRegistry(fixture.baseDir);
    const before = await listDesktopRestores(fixture.input);
    const from = registry.artifacts.find((item) => item.sha256 === registry.currentHash)!;
    const to = registry.artifacts.find((item) => item.sha256 === fixture.input.expectedHash)!;
    const id = "00000000-0000-4000-8000-000000000001";
    const stagePath = `${registry.identity.installPath}.crew-restore-${id}`;
    const controllerTemporary = NodePath.join(
      desktopRestoreDirectory(fixture.baseDir),
      `controller.sh.${id}.tmp`,
    );
    await writeDesktopRestoreJson(
      NodePath.join(desktopRestoreDirectory(fixture.baseDir), "transaction.json"),
      {
        id,
        installationId: registry.installationId,
        from,
        to,
        stagePath,
        phase: "staging",
        originalHold: false,
      },
    );
    await NodeFSP.writeFile(controllerTemporary, "partial controller");
    if (phase === "partial") await NodeFSP.writeFile(stagePath, "partial");
    if (phase === "copied")
      await NodeFSP.copyFile(desktopRestoreArtifactPath(fixture.baseDir, to), stagePath);
    if (phase === "unpublishedOwner") {
      await using owner = await startRestoreLockOwner();
      const file = NodePath.join(
        desktopRestoreDirectory(fixture.baseDir),
        `.mutation-owner-${owner.identity.replace(":", "-")}-${id}`,
      );
      await NodeFSP.writeFile(file, "", { mode: 0o600 });
      await owner.stop();
      expect(await recoverDesktopRestoreBeforeStartup({ baseDir: fixture.baseDir })).toBe(false);
      await expect(NodeFSP.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
    if (phase === "orphanRecovery" || phase === "heldRecovery") {
      const lock = NodePath.join(desktopRestoreDirectory(fixture.baseDir), "mutation.lock");
      const recovery = `${lock}.recovery`;
      await using owner = await startRestoreLockOwner();
      await NodeFSP.writeFile(lock, owner.identity, { mode: 0o600 });
      await expect(
        recoverDesktopRestoreBeforeStartup({ baseDir: fixture.baseDir }),
      ).rejects.toThrow("Another desktop restore operation is active");
      if (phase === "orphanRecovery") {
        await NodeFSP.writeFile(lock, `${owner.identity}\n`);
        await expect(
          recoverDesktopRestoreBeforeStartup({ baseDir: fixture.baseDir }),
        ).rejects.toThrow("unknown owner");
        expect(await NodeFSP.readFile(lock, "utf8")).toBe(`${owner.identity}\n`);
        await NodeFSP.writeFile(lock, owner.identity);
      }
      await NodeFSP.rm(recovery, { force: true });
      if (phase === "orphanRecovery") await NodeFSP.writeFile(recovery, "", { mode: 0o600 });
      else await NodeFSP.link(lock, recovery);
      const before = await NodeFSP.lstat(recovery);
      const recoveryContent = await NodeFSP.readFile(recovery, "utf8");
      await expect(
        recoverDesktopRestoreBeforeStartup({ baseDir: fixture.baseDir }),
      ).rejects.toThrow();
      expect(await NodeFSP.readFile(lock, "utf8")).toBe(owner.identity);
      await owner.stop();
      if (phase === "heldRecovery") {
        await using recovering = await startRestoreLockOwner(recovery);
        await expect(
          recoverDesktopRestoreBeforeStartup({ baseDir: fixture.baseDir }),
        ).rejects.toThrow("Another desktop restore operation");
        expect(await NodeFSP.readFile(lock, "utf8")).toBe(owner.identity);
        expect((await NodeFSP.lstat(recovery)).ino).toBe(before.ino);
        await recovering.stop();
      }
      expect(await recoverDesktopRestoreBeforeStartup({ baseDir: fixture.baseDir })).toBe(false);
      expect((await NodeFSP.lstat(recovery)).ino).toBe(before.ino);
      expect(await NodeFSP.readFile(recovery, "utf8")).toBe(recoveryContent);
      await expect(NodeFSP.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const bytes =
      phase === "partial" || phase === "copied" ? (await NodeFSP.stat(stagePath)).size : 0;
    expect((await listDesktopRestores(fixture.input)).totalBytes).toBe(before.totalBytes + bytes);
    expect(await recoverDesktopRestoreBeforeStartup({ baseDir: fixture.baseDir })).toBe(false);
    expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
    await expect(NodeFSP.lstat(stagePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(NodeFSP.lstat(controllerTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await desktopRestoreFileDigest(fixture.identity.installPath)).toMatchObject({
      sha256: from.sha256,
    });
    expect((await listDesktopRestores(fixture.input)).totalBytes).toBe(before.totalBytes);
    expect(fixture.quiesce).not.toHaveBeenCalled();
    expect(fixture.launch).not.toHaveBeenCalled();
  });

  it.each(["mutation.lock", "mutation.lock.recovery"] as const)(
    "preserves an untrusted %s symlink and its target",
    async (name) => {
      await using fixture = await setup();
      const file = NodePath.join(desktopRestoreDirectory(fixture.baseDir), name);
      const target = NodePath.join(fixture.identity.userDataDir, "auth-token");
      const original = await NodeFSP.readFile(target, "utf8");
      await NodeFSP.rm(file, { force: true });
      await NodeFSP.symlink(target, file);
      const before = await NodeFSP.lstat(file);
      await expect(releaseDesktopUpdateHold(fixture.input)).rejects.toThrow();
      expect((await NodeFSP.lstat(file)).ino).toBe(before.ino);
      expect(await NodeFSP.readlink(file)).toBe(target);
      expect(await NodeFSP.readFile(target, "utf8")).toBe(original);
    },
  );

  it.each(["artifact", "schema", "events", "profile", "current", "cap", "identity"] as const)(
    "refuses %s changes before requesting shutdown",
    async (change) => {
      await using fixture = await setup();
      const registry = await readDesktopRestoreRegistry(fixture.baseDir);
      const candidate = registry.artifacts.find((item) => item.version === "1.0.0")!;
      if (change === "artifact") {
        await NodeFSP.chmod(desktopRestoreArtifactPath(fixture.baseDir, candidate), 0o700);
        await NodeFSP.appendFile(
          desktopRestoreArtifactPath(fixture.baseDir, candidate),
          "corruption",
        );
      } else if (change === "current") fixture.input.expectedCurrentVersion = "1.0.2";
      else if (change === "schema") {
        const db = new NodeSqlite.DatabaseSync(
          NodePath.join(fixture.identity.stateDir, "statev2.sqlite"),
        );
        try {
          db.exec("ALTER TABLE chats ADD COLUMN newer TEXT");
        } finally {
          db.close();
        }
      } else {
        const changed =
          change === "cap"
            ? { ...registry, maxBytes: 1 }
            : change === "identity"
              ? { ...registry, identity: { ...registry.identity, environmentId: "different" } }
              : {
                  ...registry,
                  artifacts: registry.artifacts.map((item) =>
                    item === candidate
                      ? { ...item, build: { ...item.build!, [change]: "c".repeat(64) } }
                      : item,
                  ),
                };
        await writeDesktopRestoreJson(
          NodePath.join(desktopRestoreDirectory(fixture.baseDir), "registry.json"),
          changed,
        );
      }
      expect((await restoreDesktopVersion(fixture.input)).status).toBe("failed");
      expect(fixture.quiesce).not.toHaveBeenCalled();
      expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
      expect(
        await NodeFSP.readFile(NodePath.join(fixture.identity.userDataDir, "auth-token"), "utf8"),
      ).toBe("fixture-auth");
    },
  );

  it("returns to the original artifact when the restored build fails runtime health", async () => {
    await using fixture = await setup();
    const before = await desktopRestoreFileDigest(fixture.identity.installPath);
    await restoreDesktopVersion(fixture.input);
    const transaction = (await readDesktopRestoreTransaction(fixture.baseDir))!;
    fixture.health.mockImplementation(async (_baseDir, _transaction, version) => {
      if (version === "1.0.0") throw new Error("fixture health failure");
    });
    await expect(
      runDesktopRestoreController(
        { baseDir: fixture.baseDir, transactionId: transaction.id },
        fixture.runtime,
      ),
    ).rejects.toThrow("fixture health failure");
    expect((await desktopRestoreFileDigest(fixture.identity.installPath)).sha256).toBe(
      before.sha256,
    );
    expect((await listDesktopRestores(fixture.input)).currentVersion).toBe("1.0.1");
    expect(fixture.health).toHaveBeenLastCalledWith(
      fixture.baseDir,
      expect.anything(),
      "1.0.1",
      before.sha256,
    );
    expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
  });

  it.each([
    { environment: { XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" }, passwordStore: null },
    { environment: {}, passwordStore: "kwallet5" },
  ])(
    "stops a target without Ready and preserves password-store context from SSH: %j",
    async ({ environment, passwordStore }) => {
      await using fixture = await setup(true, environment, passwordStore);
      const previous = Object.fromEntries(
        [
          "DISPLAY",
          "WAYLAND_DISPLAY",
          "XDG_RUNTIME_DIR",
          "XDG_CONFIG_HOME",
          "T3CODE_HOME",
          "T3CODE_DESKTOP_PROFILE",
          "XDG_CURRENT_DESKTOP",
          "KDE_SESSION_VERSION",
          "T3CODE_NIX_DATA_DIR",
          "T3CODE_NIX_LAUNCHER",
        ].map((key) => [key, process.env[key]]),
      );
      const started: DesktopRestoreProcess[] = [];
      try {
        delete process.env.DISPLAY;
        delete process.env.WAYLAND_DISPLAY;
        delete process.env.XDG_RUNTIME_DIR;
        process.env.XDG_CURRENT_DESKTOP = "GNOME";
        process.env.KDE_SESSION_VERSION = "wrong-generation";
        process.env.T3CODE_NIX_DATA_DIR = "/wrong-nix-data";
        process.env.T3CODE_NIX_LAUNCHER = "/wrong-launcher";
        process.env.XDG_CONFIG_HOME = "/wrong-config";
        process.env.T3CODE_HOME = "/wrong-home";
        process.env.T3CODE_DESKTOP_PROFILE = "wrong-profile";
        const original = await desktopRestoreFileDigest(fixture.identity.installPath);
        const databasePath = NodePath.join(fixture.identity.stateDir, "statev2.sqlite");
        const databaseBefore = await desktopRestoreFileDigest(databasePath);
        expect((await restoreDesktopVersion(fixture.input)).status).toBe("scheduled");
        const transaction = (await readDesktopRestoreTransaction(fixture.baseDir))!;
        const health: DesktopRestoreControllerRuntime["health"] = async (
          _baseDir,
          _transaction,
          version,
        ) => {
          const receipt = await readReceipt(
            NodePath.join(fixture.identity.userDataDir, `started-${version}.json`),
          );
          expect(receipt).toMatchObject({
            acquired: true,
            home: fixture.baseDir,
            profileId: fixture.identity.profileId,
            config: NodePath.dirname(fixture.identity.userDataDir),
            wayland: "wayland-0",
            runtime: fixture.graphicsDirectory,
            passwordStore: passwordStore === null ? [] : [`--password-store=${passwordStore}`],
          });
          expect(receipt.desktop).toBe(environment.XDG_CURRENT_DESKTOP);
          expect(receipt.kde).toBe(environment.KDE_SESSION_VERSION);
          expect(receipt.nixDataDir).toBeUndefined();
          expect(receipt.nixLauncher).toBeUndefined();
          const current = (await readDesktopRestoreTransaction(fixture.baseDir))!;
          expect(current.launchedProcess?.pid).toBe(receipt.pid);
          started.push(current.launchedProcess!);
          if (version === "1.0.0") {
            await expect(
              NodeFSP.stat(NodePath.join(desktopRestoreDirectory(fixture.baseDir), "session.json")),
            ).rejects.toMatchObject({ code: "ENOENT" });
            throw new Error("Target backend never reached Ready");
          }
        };
        let firstShutdown = true;
        await expect(
          runDesktopRestoreController(
            { baseDir: fixture.baseDir, transactionId: transaction.id },
            {
              ...desktopRestoreControllerRuntime,
              quiesce: async (baseDir, current) => {
                if (firstShutdown) {
                  firstShutdown = false;
                  return;
                }
                await desktopRestoreControllerRuntime.quiesce(baseDir, current);
              },
              health,
            },
          ),
        ).rejects.toThrow("Target backend never reached Ready");
        expect(started).toHaveLength(2);
        expect(await desktopRestoreProcessIdentity(started[0]!.pid)).not.toBe(
          started[0]!.processIdentity,
        );
        expect(await desktopRestoreProcessIdentity(started[1]!.pid)).toBe(
          started[1]!.processIdentity,
        );
        expect((await desktopRestoreFileDigest(fixture.identity.installPath)).sha256).toBe(
          original.sha256,
        );
        expect(await desktopRestoreFileDigest(databasePath)).toEqual(databaseBefore);
        expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
        expect(await isDesktopUpdateHeld(fixture.input)).toBe(true);
        expect(
          await NodeFSP.readFile(NodePath.join(fixture.identity.userDataDir, "auth-token"), "utf8"),
        ).toBe("fixture-auth");
        const context = await readDesktopRestoreLaunchContext(
          fixture.baseDir,
          transaction.installationId,
        );
        expect(context.environment).toEqual({
          XDG_CONFIG_HOME: NodePath.dirname(fixture.identity.userDataDir),
          XDG_RUNTIME_DIR: fixture.graphicsDirectory,
          WAYLAND_DISPLAY: "wayland-0",
          ...environment,
        });
        expect(context.passwordStore).toBe(passwordStore);
        expect(
          await NodeFSP.readFile(
            NodePath.join(desktopRestoreDirectory(fixture.baseDir), "graphics.json"),
            "utf8",
          ),
        ).not.toContain("never-copy-this");
      } finally {
        for (const owner of started) {
          if ((await desktopRestoreProcessIdentity(owner.pid)) !== owner.processIdentity) continue;
          const exited = readReceipt(
            NodePath.join(fixture.identity.userDataDir, "exited-1.0.1.json"),
          );
          process.kill(owner.pid, "SIGTERM");
          await exited;
        }
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

  it.each(["missing", "stale"] as const)(
    "refuses a %s graphical context before stopping or switching",
    async (condition) => {
      await using fixture = await setup();
      const before = await desktopRestoreFileDigest(fixture.identity.installPath);
      const file = NodePath.join(desktopRestoreDirectory(fixture.baseDir), "graphics.json");
      if (condition === "missing") await NodeFSP.unlink(file);
      else {
        const context = JSON.parse(await NodeFSP.readFile(file, "utf8")) as Record<string, unknown>;
        await writeDesktopRestoreJson(file, { ...context, bootId: "previous-boot" });
      }
      expect(await restoreDesktopVersion(fixture.input)).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("graphical context"),
      });
      expect(fixture.quiesce).not.toHaveBeenCalled();
      expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
      expect((await desktopRestoreFileDigest(fixture.identity.installPath)).sha256).toBe(
        before.sha256,
      );
    },
  );

  it("refuses a missing stop endpoint while the exact original desktop process is alive", async () => {
    await using fixture = await setup();
    const before = await desktopRestoreFileDigest(fixture.identity.installPath);
    await restoreDesktopVersion(fixture.input);
    const transaction = (await readDesktopRestoreTransaction(fixture.baseDir))!;
    await expect(
      runDesktopRestoreController({ baseDir: fixture.baseDir, transactionId: transaction.id }),
    ).rejects.toThrow("no usable graceful shutdown endpoint");
    expect(await desktopRestoreProcessIdentity(transaction.originalProcess!.pid)).toBe(
      transaction.originalProcess!.processIdentity,
    );
    expect((await desktopRestoreFileDigest(fixture.identity.installPath)).sha256).toBe(
      before.sha256,
    );
    expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
  });

  it.each([false, true])(
    "recovers an interrupted switch with a changed boot context: %s",
    async (changedBoot) => {
      await using fixture = await setup(true);
      const before = await desktopRestoreFileDigest(fixture.identity.installPath);
      await restoreDesktopVersion(fixture.input);
      const transaction = (await readDesktopRestoreTransaction(fixture.baseDir))!;
      await NodeFSP.rename(transaction.stagePath!, fixture.identity.installPath);
      const starting = { ...transaction, phase: "starting" as const };
      await writeDesktopRestoreJson(
        NodePath.join(desktopRestoreDirectory(fixture.baseDir), "transaction.json"),
        starting,
      );
      const registry = await readDesktopRestoreRegistry(fixture.baseDir);
      await desktopRestoreControllerRuntime.launch(registry, starting);
      const target = (await readDesktopRestoreTransaction(fixture.baseDir))!.launchedProcess!;
      const owners = [target];
      try {
        expect(
          await readReceipt(NodePath.join(fixture.identity.userDataDir, "started-1.0.0.json")),
        ).toMatchObject({ acquired: true, pid: target.pid });
        fixture.health.mockImplementation(async (_baseDir, _transaction, version) => {
          const owner = (await readDesktopRestoreTransaction(fixture.baseDir))!.launchedProcess!;
          owners.push(owner);
          expect(version).toBe("1.0.1");
          expect(
            await readReceipt(
              NodePath.join(fixture.identity.userDataDir, `started-${version}.json`),
            ),
          ).toMatchObject({ acquired: true, pid: owner.pid });
        });
        if (changedBoot) {
          const resumedGraphics = await fixture.changeGraphicsSession();
          await NodeFSP.writeFile(
            `${fixture.identity.installPath}.crew-restore-${transaction.id}-recovery`,
            "interrupted recovery copy",
            { mode: 0o600 },
          );
          const file = NodePath.join(desktopRestoreDirectory(fixture.baseDir), "graphics.json");
          const context = JSON.parse(await NodeFSP.readFile(file, "utf8")) as Record<
            string,
            unknown
          >;
          await writeDesktopRestoreJson(file, { ...context, bootId: "previous-boot" });
          await expect(
            runDesktopRestoreController(
              { baseDir: fixture.baseDir, transactionId: transaction.id },
              { ...desktopRestoreControllerRuntime, health: fixture.health },
            ),
          ).rejects.toThrow("pendingHealth");
          expect((await desktopRestoreFileDigest(fixture.identity.installPath)).sha256).toBe(
            before.sha256,
          );
          expect((await readDesktopRestoreTransaction(fixture.baseDir))?.pendingHealth).toBe(true);
          expect((await listDesktopRestores(fixture.input)).unavailableReason).toContain(
            "pendingHealth",
          );
          const previous = Object.fromEntries(
            [
              "DISPLAY",
              "WAYLAND_DISPLAY",
              "XDG_RUNTIME_DIR",
              "XAUTHORITY",
              "DBUS_SESSION_BUS_ADDRESS",
            ].map((key) => [key, process.env[key]]),
          );
          try {
            delete process.env.DISPLAY;
            delete process.env.XAUTHORITY;
            delete process.env.DBUS_SESSION_BUS_ADDRESS;
            process.env.WAYLAND_DISPLAY = "wayland-0";
            process.env.XDG_RUNTIME_DIR = resumedGraphics;
            expect(
              await recoverDesktopRestoreBeforeStartup({
                baseDir: fixture.baseDir,
                appDataDirectory: NodePath.dirname(fixture.identity.userDataDir),
                passwordStore: null,
              }),
            ).toBe(true);
            const fresh = await readDesktopRestoreLaunchContext(
              fixture.baseDir,
              registry.installationId,
            );
            expect(fresh.bootId).not.toBe("previous-boot");
            expect(fresh.environment.XDG_RUNTIME_DIR).toBe(resumedGraphics);
            expect(fresh.bootId).toBe(
              (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
            );
          } finally {
            for (const [key, value] of Object.entries(previous)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          }
        }
        await runDesktopRestoreController(
          { baseDir: fixture.baseDir, transactionId: transaction.id },
          { ...desktopRestoreControllerRuntime, health: fixture.health },
        );
        expect(await desktopRestoreProcessIdentity(target.pid)).not.toBe(target.processIdentity);
      } finally {
        for (const owner of owners) {
          if ((await desktopRestoreProcessIdentity(owner.pid)) !== owner.processIdentity) continue;
          const version = owner === target ? "1.0.0" : "1.0.1";
          const exited = readReceipt(
            NodePath.join(fixture.identity.userDataDir, `exited-${version}.json`),
          );
          process.kill(owner.pid, "SIGTERM");
          await exited;
        }
      }
      expect((await desktopRestoreFileDigest(fixture.identity.installPath)).sha256).toBe(
        before.sha256,
      );
      expect(fixture.health).toHaveBeenCalledTimes(1);
      expect(await isDesktopUpdateHeld(fixture.input)).toBe(true);
    },
  );

  it("relaunches Nix with the registry data directory and launcher despite an SSH data home", async () => {
    await using fixture = await setup(true);
    await restoreDesktopVersion(fixture.input);
    const transaction = (await readDesktopRestoreTransaction(fixture.baseDir))!;
    const registry = await readDesktopRestoreRegistry(fixture.baseDir);
    const previous = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/ssh-data-home";
      await desktopRestoreControllerRuntime.launch(
        {
          ...registry,
          identity: { ...registry.identity, kind: "nix", nixDataDir: "/bound-nix-data" },
        },
        transaction,
      );
      const launched = (await readDesktopRestoreTransaction(fixture.baseDir))!;
      try {
        expect(
          await readReceipt(NodePath.join(fixture.identity.userDataDir, "started-1.0.1.json")),
        ).toMatchObject({
          acquired: true,
          nixDataDir: "/bound-nix-data",
          nixLauncher: registry.identity.launcherPath,
        });
      } finally {
        const exited = readReceipt(
          NodePath.join(fixture.identity.userDataDir, "exited-1.0.1.json"),
        );
        await desktopRestoreControllerRuntime.quiesce(fixture.baseDir, launched);
        await exited;
      }
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    }
  });

  it.each(["eviction", "partialCopy", "copy", "registry"] as const)(
    "reconciles a registration interrupted after %s across multiple updates",
    async (interruption) => {
      await using fixture = await setup();
      const before = await readDesktopRestoreRegistry(fixture.baseDir);
      const evicted = before.artifacts.find((item) => item.sha256 !== before.currentHash)!;
      const directory = desktopRestoreDirectory(fixture.baseDir);
      const retentionFile = NodePath.join(directory, "retention.json");
      const orphan = NodePath.join(directory, "artifacts", "foreign-orphan");
      await NodeFSP.writeFile(orphan, "foreign");
      await expect(fixture.install("1.0.2")).rejects.toThrow("Physical desktop restore inventory");
      expect(await NodeFSP.readFile(orphan, "utf8")).toBe("foreign");
      await NodeFSP.unlink(orphan);
      await fixture.install("1.0.2");
      const registered = await readDesktopRestoreRegistry(fixture.baseDir);
      const current = registered.artifacts.find((item) => item.sha256 === registered.currentHash)!;
      const journal = JSON.parse(await NodeFSP.readFile(retentionFile, "utf8")) as Record<
        string,
        unknown
      >;
      if (interruption !== "registry") {
        await writeDesktopRestoreJson(NodePath.join(directory, "registry.json"), before);
        await writeDesktopRestoreJson(retentionFile, {
          ...journal,
          inventory: registered.artifacts,
          evict: [evicted],
          copying: interruption === "eviction" ? null : current,
        });
        if (interruption === "partialCopy") {
          const file = desktopRestoreArtifactPath(fixture.baseDir, current);
          await NodeFSP.chmod(file, 0o600);
          await NodeFSP.writeFile(file, "partial");
        }
        if (interruption === "eviction")
          await NodeFSP.unlink(desktopRestoreArtifactPath(fixture.baseDir, current));
      }
      await fixture.install("1.0.2");
      await fixture.install("1.0.3");
      const latest = await readDesktopRestoreRegistry(fixture.baseDir);
      expect(latest.artifacts.map((item) => item.version)).toEqual(["1.0.2", "1.0.3"]);
      const files = await NodeFSP.readdir(NodePath.join(directory, "artifacts"));
      expect(files.sort()).toEqual(latest.artifacts.map((item) => item.fileName).sort());
      expect(latest.artifacts.every((item) => item.healthy)).toBe(true);
      expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
    },
  );

  it("rejects registration that cannot keep the current artifact and a predecessor within the cap", async () => {
    await using fixture = await setup();
    const registry = await readDesktopRestoreRegistry(fixture.baseDir);
    await expect(
      registerDesktopRestoreBuild({
        baseDir: fixture.baseDir,
        identity: fixture.identity,
        build: build("1.0.1"),
        maxBytes: registry.artifacts.at(-1)!.sizeBytes,
      }),
    ).rejects.toThrow("storage cap");
    expect((await readDesktopRestoreRegistry(fixture.baseDir)).artifacts).toHaveLength(2);
    expect(await readDesktopRestoreTransaction(fixture.baseDir)).toBeNull();
  });
});
