// @effect-diagnostics nodeBuiltinImport:off -- Shared by the standalone launcher and archive builder.
// oxlint-disable t3code/no-global-process-runtime -- Standalone launcher persistence uses the host filesystem semantics.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export const SERVER_RESTORE_MANIFEST = "restore-manifest.json";
export const SERVER_RESTORE_QUALIFIED = ".restore-qualified.json";
export const SERVER_RESTORE_PROFILE_CONTRACT = "t3-userdata-v1";
export const SERVER_RESTORE_DEFAULT_MAX_BYTES = 1024 ** 3;

export interface ServerRestoreManifest {
  readonly format: 1;
  readonly version: string;
  readonly sourceSha: string;
  readonly launcherProtocol: number;
  readonly profileContract: string;
  readonly eventContract: string;
  readonly migrations: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }>;
}

export interface ServerRestoreIdentity {
  readonly installationId: string;
  readonly baseDir: string;
  readonly dbPath: string;
  readonly environmentId: string;
}

const hashPattern = /^[a-f0-9]{64}$/;
const ignoredFiles = new Set([
  SERVER_RESTORE_MANIFEST,
  SERVER_RESTORE_QUALIFIED,
  ".install-complete",
]);

export const serverRestoreHash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

export async function serverRestoreIdentity(baseDir: string): Promise<ServerRestoreIdentity> {
  const canonical = await NodeFSP.realpath(baseDir);
  const stateDir = await NodeFSP.realpath(NodePath.join(canonical, "userdata"));
  if (stateDir !== NodePath.join(canonical, "userdata")) {
    throw new Error("Restore requires this installation's original userdata directory.");
  }
  const dbPath = NodePath.join(stateDir, "statev2.sqlite");
  if ((await NodeFSP.realpath(dbPath)) !== dbPath) {
    throw new Error("Restore does not support a redirected database.");
  }
  const environmentId = (
    await NodeFSP.readFile(NodePath.join(stateDir, "environment-id"), "utf8")
  ).trim();
  if (environmentId.length === 0 || environmentId.length > 256) {
    throw new Error("The installation has no valid environment identity.");
  }
  return {
    baseDir: canonical,
    dbPath,
    environmentId,
    installationId: serverRestoreHash(
      JSON.stringify([canonical, dbPath, environmentId, NodeOS.userInfo()]),
    ),
  };
}

export async function serverRestoreFiles(
  directory: string,
): Promise<ServerRestoreManifest["files"]> {
  const files: Array<ServerRestoreManifest["files"][number]> = [];
  const visit = async (relative: string): Promise<void> => {
    const absolute = NodePath.join(directory, relative);
    const stat = await NodeFSP.lstat(absolute);
    if (stat.isDirectory()) {
      for (const entry of (await NodeFSP.readdir(absolute)).sort()) {
        if (relative === "" && ignoredFiles.has(entry)) continue;
        await visit(relative === "" ? entry : `${relative}/${entry}`);
      }
    } else if (stat.isFile()) {
      const hash = NodeCrypto.createHash("sha256");
      for await (const chunk of NodeFS.createReadStream(absolute)) hash.update(chunk);
      files.push({ path: relative, sizeBytes: stat.size, sha256: hash.digest("hex") });
    } else if (stat.isSymbolicLink()) {
      const target = await NodeFSP.realpath(absolute);
      const inside = NodePath.relative(await NodeFSP.realpath(directory), target);
      if (inside.startsWith("..") || NodePath.isAbsolute(inside)) {
        throw new Error("The runtime contains an external symbolic link.");
      }
      // Include the link itself; its target is verified separately in the same tree.
      const link = await NodeFSP.readlink(absolute);
      files.push({
        path: relative,
        sizeBytes: Buffer.byteLength(link),
        sha256: serverRestoreHash(`symlink:${link}`),
      });
    } else {
      throw new Error("The runtime contains an unsupported file.");
    }
  };
  await visit("");
  return files;
}

export function decodeServerRestoreManifest(value: unknown): ServerRestoreManifest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const manifest = value as Partial<ServerRestoreManifest>;
  if (
    manifest.format !== 1 ||
    typeof manifest.version !== "string" ||
    !isExactServiceVersion(manifest.version) ||
    typeof manifest.sourceSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
    manifest.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL ||
    typeof manifest.profileContract !== "string" ||
    !manifest.profileContract.startsWith(`${SERVER_RESTORE_PROFILE_CONTRACT}:`) ||
    !hashPattern.test(manifest.profileContract.slice(SERVER_RESTORE_PROFILE_CONTRACT.length + 1)) ||
    typeof manifest.eventContract !== "string" ||
    !hashPattern.test(manifest.eventContract) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > 100_000 ||
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.length === 0
  )
    return undefined;
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      file.path.includes("\\") ||
      file.path.startsWith("/") ||
      file.path.split("/").some((part: string) => part === "." || part === ".." || part === "") ||
      ignoredFiles.has(file.path) ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      typeof file.sha256 !== "string" ||
      !hashPattern.test(file.sha256)
    )
      return undefined;
    paths.add(file.path);
  }
  const ids = new Set<number>();
  for (const migration of manifest.migrations) {
    if (
      typeof migration !== "object" ||
      migration === null ||
      !Number.isSafeInteger(migration.id) ||
      migration.id < 1 ||
      ids.has(migration.id) ||
      typeof migration.name !== "string" ||
      migration.name.length === 0
    )
      return undefined;
    ids.add(migration.id);
  }
  return manifest as ServerRestoreManifest;
}

export async function verifyServerRestoreRuntime(directory: string, version: string) {
  if ((await NodeFSP.lstat(directory)).isSymbolicLink())
    throw new Error("Runtime directory is redirected.");
  const text = await NodeFSP.readFile(NodePath.join(directory, SERVER_RESTORE_MANIFEST), "utf8");
  const manifest = decodeServerRestoreManifest(JSON.parse(text) as unknown);
  if (manifest === undefined || manifest.version !== version)
    throw new Error("Runtime has no supported restore manifest.");
  const files = await serverRestoreFiles(directory);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error("Runtime file checksum or size changed.");
  if (!files.some((file) => file.path === "t3" || file.path === "t3.exe"))
    throw new Error("The runtime has no standalone executable.");
  return {
    manifest,
    sha256: serverRestoreHash(text),
    sizeBytes: files.reduce((size, file) => size + file.sizeBytes, Buffer.byteLength(text)),
  };
}

export function serverRestoreDatabaseBlocker(
  databasePath: string,
  manifest: ServerRestoreManifest,
): string | undefined {
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const migrations = db
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    for (const recorded of migrations) {
      if (
        !manifest.migrations.some(
          ({ id, name }) => id === recorded.migration_id && name === recorded.name,
        )
      ) {
        return "The target does not support this database's recorded migration names.";
      }
    }
    const events = db
      .prepare("SELECT DISTINCT application_event_version FROM orchestration_events")
      .all();
    if (
      events.some(
        (row) => row.application_event_version !== 1 && row.application_event_version !== 2,
      )
    ) {
      return "The database contains an unsupported event contract version.";
    }
    return undefined;
  } finally {
    db.close();
  }
}

export async function qualifyServerRestoreRuntime(
  identity: ServerRestoreIdentity,
  version: string,
) {
  const directory = NodePath.join(identity.baseDir, "runtime", "versions", version);
  const { sha256 } = await verifyServerRestoreRuntime(directory, version);
  const destination = NodePath.join(directory, SERVER_RESTORE_QUALIFIED);
  const temporary = `${destination}.${NodeCrypto.randomUUID()}`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...identity, version, sha256 }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await NodeFSP.rename(temporary, destination);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export async function serverRestoreQualificationBlocker(
  identity: ServerRestoreIdentity,
  version: string,
  sha256: string,
): Promise<string | undefined> {
  try {
    const record: unknown = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(identity.baseDir, "runtime", "versions", version, SERVER_RESTORE_QUALIFIED),
        "utf8",
      ),
    );
    if (
      typeof record === "object" &&
      record !== null &&
      "installationId" in record &&
      record.installationId === identity.installationId &&
      "sha256" in record &&
      record.sha256 === sha256 &&
      "version" in record &&
      record.version === version
    )
      return undefined;
  } catch {}
  return "This runtime has not completed a healthy managed start in this installation.";
}

export async function serverUpdateHold(baseDir: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(baseDir, "runtime", "update-hold.json"), "utf8"),
    );
    // An invalid persisted hold must not silently re-enable forward updates.
    return (
      typeof value !== "object" || value === null || !("hold" in value) || value.hold !== false
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

export async function writeServerUpdateHold(baseDir: string, hold: boolean): Promise<void> {
  const directory = NodePath.join(baseDir, "runtime");
  const file = NodePath.join(directory, "update-hold.json");
  const temporary = `${file}.${NodeCrypto.randomUUID()}`;
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ hold }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await NodeFSP.rename(temporary, file);
    if (process.platform !== "win32") {
      const handle = await NodeFSP.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
