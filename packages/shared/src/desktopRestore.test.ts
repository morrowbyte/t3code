// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real temporary install artifacts and read-only SQLite compatibility checks.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type { DesktopRestoreControllerRuntime } from "./desktopRestoreController.ts";
import {
  desktopRestoreArtifactPath,
  desktopRestoreDirectory,
  desktopRestoreFileDigest,
  isDesktopUpdateHeld,
  listDesktopRestores,
  markDesktopRestoreHealthy,
  readDesktopRestoreRegistry,
  readDesktopRestoreTransaction,
  registerDesktopRestoreBuild,
  releaseDesktopUpdateHold,
  restoreDesktopVersion,
  runDesktopRestoreController,
  writeDesktopRestoreJson,
  type DesktopRestoreBuild,
  type DesktopRestoreIdentity,
} from "./desktopRestore.ts";

const fingerprint = "a".repeat(64);
const build = (version: string): DesktopRestoreBuild => ({
  protocol: 1,
  version,
  sourceSha: "b".repeat(40),
  database: fingerprint,
  events: fingerprint,
  profile: fingerprint,
  updateHold: true,
});

async function setup() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crew-desktop-restore-"));
  const baseDir = NodePath.join(directory, "home");
  const stateDir = NodePath.join(baseDir, "userdata");
  const userDataDir = NodePath.join(directory, "electron-profile");
  const installPath = NodePath.join(directory, "Crew.AppImage");
  await NodeFSP.mkdir(stateDir, { recursive: true });
  await NodeFSP.mkdir(userDataDir);
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
      `#!/bin/sh\n[ "$1" = '--appimage-mount' ] || exit 2\nexec ${shellWord(process.execPath)} -e ${shellWord(mounter)}\n`,
      { mode: 0o755 },
    );
    await registerDesktopRestoreBuild({ baseDir, identity, build: metadata });
    await markDesktopRestoreHealthy({ baseDir, identity, build: metadata });
  };
  await install("1.0.0");
  await install("1.0.1");
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
    runtime: { quiesce, launch, health },
    async [Symbol.asyncDispose]() {
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

  it("recovers an interrupted switch to the original rather than accepting an unobserved target", async () => {
    await using fixture = await setup();
    const before = await desktopRestoreFileDigest(fixture.identity.installPath);
    await restoreDesktopVersion(fixture.input);
    const transaction = (await readDesktopRestoreTransaction(fixture.baseDir))!;
    await NodeFSP.rename(transaction.stagePath!, fixture.identity.installPath);
    await writeDesktopRestoreJson(
      NodePath.join(desktopRestoreDirectory(fixture.baseDir), "transaction.json"),
      { ...transaction, phase: "starting" },
    );
    await runDesktopRestoreController(
      { baseDir: fixture.baseDir, transactionId: transaction.id },
      fixture.runtime,
    );
    expect((await desktopRestoreFileDigest(fixture.identity.installPath)).sha256).toBe(
      before.sha256,
    );
    expect(fixture.health).toHaveBeenCalledTimes(1);
    expect(await isDesktopUpdateHeld(fixture.input)).toBe(true);
  });

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
