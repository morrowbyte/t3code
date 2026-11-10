// @effect-diagnostics nodeBuiltinImport:off -- GUI-independent installer boundary shared by the desktop and bundled CLI.
import type { AppRestoreInput, AppRestoreResult, AppRestoreState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { sampleStorage, storagePressureMessage } from "./node/storagePressure.ts";
import {
  NixClosureMember,
  readNixRestoreClosure,
  readNixRestoreProvenance,
  retainNixRestoreRoot,
  retainedDesktopBytes,
} from "./desktopRestoreNix.ts";
import { renderDesktopRestoreLauncher } from "./desktopRestoreLauncher.ts";
import {
  DesktopRestoreProcess,
  readDesktopRestoreLaunchContext,
} from "./desktopRestoreGraphics.ts";
export { DesktopRestoreProcess } from "./desktopRestoreGraphics.ts";

const HASH = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const VERSION = Schema.String.check(Schema.isPattern(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/));
const POSITIVE = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const DesktopRestoreBuild = Schema.Struct({
  protocol: Schema.Literal(1),
  version: VERSION,
  sourceSha: Schema.NullOr(Schema.String),
  database: HASH,
  events: HASH,
  profile: HASH,
  updateHold: Schema.Literal(true),
});
export type DesktopRestoreBuild = typeof DesktopRestoreBuild.Type;

const Identity = Schema.Struct({
  kind: Schema.Literals(["appimage", "nix", "nsis"]),
  installPath: Schema.String,
  baseDir: Schema.String,
  stateDir: Schema.String,
  userDataDir: Schema.String,
  profileId: Schema.NullOr(Schema.String),
  environmentId: Schema.String,
  launcherPath: Schema.String,
  updaterPath: Schema.NullOr(Schema.String),
  nixDataDir: Schema.NullOr(Schema.String),
});
export type DesktopRestoreIdentity = typeof Identity.Type;

const Artifact = Schema.Struct({
  version: VERSION,
  sourceSha: Schema.NullOr(Schema.String),
  sha256: HASH,
  sizeBytes: POSITIVE,
  fileName: Schema.String,
  build: Schema.NullOr(DesktopRestoreBuild),
  schemaDigest: Schema.NullOr(HASH),
  healthy: Schema.Boolean,
  nixStorePath: Schema.NullOr(Schema.String),
  nixClosure: Schema.optionalKey(Schema.Array(NixClosureMember)),
});
type Artifact = typeof Artifact.Type;

const Retention = Schema.Struct({
  format: Schema.Literal(1),
  installationId: HASH,
  inventory: Schema.Array(Artifact),
  evict: Schema.Array(Artifact),
  copying: Schema.NullOr(Artifact),
});
const decodeRetention = Schema.decodeUnknownSync(Retention);

const Registry = Schema.Struct({
  format: Schema.Literal(1),
  installationId: HASH,
  identity: Identity,
  currentVersion: VERSION,
  currentHash: HASH,
  updateHold: Schema.Boolean,
  maxVersions: POSITIVE,
  maxBytes: POSITIVE,
  artifacts: Schema.Array(Artifact),
});
export type DesktopRestoreRegistry = typeof Registry.Type;

const Transaction = Schema.Struct({
  id: Schema.String,
  installationId: HASH,
  from: Artifact,
  to: Artifact,
  phase: Schema.Literals(["staging", "prepared", "switching", "starting", "recovering"]),
  stagePath: Schema.NullOr(Schema.String),
  originalHold: Schema.Boolean,
  originalProcess: Schema.optionalKey(DesktopRestoreProcess),
  launchedProcess: Schema.optionalKey(DesktopRestoreProcess),
  pendingHealth: Schema.optionalKey(Schema.Boolean),
});
export type DesktopRestoreTransaction = typeof Transaction.Type;

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeBuild = Schema.decodeUnknownSync(DesktopRestoreBuild);
const decodeIdentity = Schema.decodeUnknownSync(Identity);
const decodeRegistry = Schema.decodeUnknownSync(Registry);
const decodeTransaction = Schema.decodeUnknownSync(Transaction);
const decodeHomeBinding = Schema.decodeUnknownSync(
  Schema.Struct({ format: Schema.Literal(1), baseDir: Schema.String }),
);
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const RESERVE_BYTES = 64 * 1024 ** 2;

async function admitStorage(directories: readonly string[], bytes: number) {
  for (const sample of await sampleStorage(directories)) {
    const reason = storagePressureMessage(sample, bytes + RESERVE_BYTES);
    if (reason !== null)
      throw new Error("Insufficient verified storage headroom for desktop restore.");
  }
}

async function syncFile(file: string) {
  const handle = await NodeFSP.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function desktopRestoreDirectory(baseDir: string) {
  if (!NodePath.isAbsolute(baseDir)) throw new Error("Desktop restore requires an absolute home.");
  return NodePath.join(baseDir, "runtime", "desktop-restore");
}

const paths = (baseDir: string) => {
  const directory = desktopRestoreDirectory(baseDir);
  return {
    directory,
    registry: NodePath.join(directory, "registry.json"),
    transaction: NodePath.join(directory, "transaction.json"),
    artifacts: NodePath.join(directory, "artifacts"),
  };
};

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

export async function desktopRestoreFileDigest(file: string) {
  const stat = await NodeFSP.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Artifact is not a regular file.");
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), sizeBytes: stat.size };
}

export async function writeDesktopRestoreJson(file: string, value: unknown) {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone controller also runs before an Effect runtime exists.
  if (process.platform !== "win32") {
    const directory = await NodeFSP.open(NodePath.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function isMissing(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

async function readJson(file: string): Promise<unknown> {
  const stat = await NodeFSP.lstat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024 || stat.isSymbolicLink()) {
    throw new Error("Invalid desktop restore metadata.");
  }
  return JSON.parse(await NodeFSP.readFile(file, "utf8"));
}

async function removeOwnedArtifact(
  baseDir: string,
  identity: DesktopRestoreIdentity,
  item: Artifact,
) {
  if (
    item.nixStorePath !== null &&
    identity.nixDataDir !== null &&
    (await NodeFSP.realpath(NodePath.join(identity.nixDataDir, "current"))) === item.nixStorePath
  )
    throw new Error("Cannot evict the selected Nix installation.");
  const file =
    item.nixStorePath === null
      ? desktopRestoreArtifactPath(baseDir, item)
      : NodePath.join(paths(baseDir).directory, "nix-roots", item.sha256);
  try {
    const stat = await NodeFSP.lstat(file);
    if (
      stat.uid !== process.getuid?.() ||
      (item.nixStorePath === null
        ? !stat.isFile() || stat.isSymbolicLink()
        : !stat.isSymbolicLink() || (await NodeFSP.realpath(file)) !== item.nixStorePath)
    )
      throw new Error("Owned desktop restore inventory changed.");
    await NodeFSP.unlink(file);
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }
  if (item.nixStorePath !== null && identity.nixDataDir !== null) {
    const root = NodePath.join(
      identity.nixDataDir,
      ".gcroots",
      NodePath.basename(item.nixStorePath),
    );
    try {
      const stat = await NodeFSP.lstat(root);
      const provenance = await readNixRestoreProvenance(identity.nixDataDir, item.version);
      if (
        !stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        provenance.storePath !== item.nixStorePath ||
        (await NodeFSP.realpath(root)) !== item.nixStorePath
      )
        throw new Error("Owned Nix installer root changed.");
      await NodeFSP.unlink(root);
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
    }
  }
}

async function reconcileRetention(
  baseDir: string,
  identity: DesktopRestoreIdentity,
  installationId: string,
) {
  const file = NodePath.join(paths(baseDir).directory, "retention.json");
  let retention;
  try {
    retention = decodeRetention(await readJson(file));
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (retention.installationId !== installationId)
    throw new Error("Desktop retention inventory belongs to another installation.");
  for (const item of retention.evict) await removeOwnedArtifact(baseDir, identity, item);
  if (retention.copying !== null) {
    const copying = retention.copying;
    try {
      await verifyDesktopRestoreArtifact(baseDir, copying);
    } catch {
      await removeOwnedArtifact(baseDir, identity, copying);
      retention = {
        ...retention,
        inventory: retention.inventory.filter((item) => item.sha256 !== copying.sha256),
      };
    }
  }
  const next = { ...retention, evict: [], copying: null };
  await writeDesktopRestoreJson(file, next);
  return next;
}

async function physicalRetention(baseDir: string, identity: DesktopRestoreIdentity) {
  const files: { sizeBytes: number; nixClosure?: readonly NixClosureMember[] }[] = [];
  let count = 0;
  const directory =
    identity.kind === "nix"
      ? NodePath.join(paths(baseDir).directory, "nix-roots")
      : paths(baseDir).artifacts;
  const roots = new Set<string>();
  const directories =
    identity.kind === "nix" && identity.nixDataDir !== null
      ? [directory, NodePath.join(identity.nixDataDir, ".gcroots")]
      : [directory];
  for (const parent of directories) {
    let entries;
    try {
      entries = await NodeFSP.readdir(parent);
    } catch (cause) {
      if (isMissing(cause)) continue;
      throw cause;
    }
    if (entries.length > 100) throw new Error("Desktop physical inventory exceeds its size bound.");
    for (const name of entries) {
      const file = NodePath.join(parent, name);
      const stat = await NodeFSP.lstat(file);
      if (identity.kind === "nix") {
        if (!stat.isSymbolicLink()) throw new Error("Unrecognized Nix restore inventory entry.");
        const storePath = await NodeFSP.realpath(file);
        if (roots.has(storePath)) continue;
        roots.add(storePath);
        const closure = await readNixRestoreClosure(storePath, false);
        files.push({ sizeBytes: closure.sizeBytes, nixClosure: closure.members });
      } else {
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("Unrecognized desktop restore inventory entry.");
        files.push({ sizeBytes: stat.size });
      }
      count += 1;
    }
  }
  const transaction = await readDesktopRestoreTransaction(baseDir);
  if (transaction?.stagePath !== null && transaction?.stagePath !== undefined) {
    if (transaction.stagePath !== `${identity.installPath}.crew-restore-${transaction.id}`)
      throw new Error("Desktop staging identity changed.");
    try {
      const stat = await NodeFSP.lstat(transaction.stagePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
        throw new Error("Desktop staging ownership changed.");
      files.push({ sizeBytes: stat.size });
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
    }
  }
  return { count, bytes: retainedDesktopBytes(files), roots, files };
}

async function bindNixRestoreHome(identity: DesktopRestoreIdentity) {
  if (identity.nixDataDir === null) return;
  const file = NodePath.join(identity.nixDataDir, "restore-home.json");
  try {
    const stat = await NodeFSP.lstat(file);
    const binding = decodeHomeBinding(await readJson(file));
    if (
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      binding.baseDir !== identity.baseDir
    )
      throw new Error("Nix installation is bound to another app home.");
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
    const handle = await NodeFSP.open(file, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ format: 1, baseDir: identity.baseDir })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function readDesktopRestoreRegistry(baseDir: string) {
  const registry = decodeRegistry(await readJson(paths(baseDir).registry));
  if (
    registry.identity.baseDir !== NodePath.resolve(baseDir) ||
    registry.installationId !== digest(JSON.stringify(registry.identity)) ||
    registry.maxVersions < 2 ||
    registry.maxVersions > 10
  ) {
    throw new Error("Desktop restore installation identity changed.");
  }
  for (const item of registry.artifacts) {
    if (item.fileName !== `${item.sha256}.AppImage` && registry.identity.kind === "appimage") {
      throw new Error("Invalid desktop artifact path.");
    }
  }
  return registry;
}

export async function readDesktopRestoreTransaction(baseDir: string) {
  try {
    const transaction = decodeTransaction(await readJson(paths(baseDir).transaction));
    if (!/^[0-9a-f-]{36}$/.test(transaction.id)) throw new Error("Invalid restore transaction.");
    return transaction;
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
}

export async function desktopRestoreProcessIdentity(pid: number): Promise<string | null> {
  try {
    const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : `${pid}:${fields[19]}`;
  } catch (cause) {
    if (
      isMissing(cause) ||
      (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH")
    )
      return null;
    throw cause;
  }
}

async function withLock<A>(baseDir: string, operation: () => Promise<A>): Promise<A> {
  const directory = paths(baseDir).directory;
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = NodePath.join(directory, "mutation.lock");
  const identity = await desktopRestoreProcessIdentity(process.pid);
  let handle;
  try {
    handle = await NodeFSP.open(lock, "wx", 0o600);
  } catch (cause) {
    if (
      !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
    )
      throw cause;
    const recoveryLock = `${lock}.recovery`;
    const recovery = await NodeFSP.open(recoveryLock, "wx", 0o600);
    try {
      const owner = String(await NodeFSP.readFile(lock, "utf8")).split(":");
      if (
        owner.length !== 2 ||
        !/^\d+$/.test(owner[0]!) ||
        (await desktopRestoreProcessIdentity(Number(owner[0]))) === owner.join(":")
      ) {
        throw new Error("Another desktop restore operation is active.", { cause });
      }
      await NodeFSP.unlink(lock);
      handle = await NodeFSP.open(lock, "wx", 0o600);
    } finally {
      await recovery.close();
      await NodeFSP.unlink(recoveryLock);
    }
  }
  try {
    await handle.writeFile(identity ?? "unavailable");
    await discardUnfinishedStaging(baseDir);
    return await operation();
  } finally {
    await handle.close();
    await NodeFSP.unlink(lock);
  }
}

async function discardUnfinishedStaging(baseDir: string) {
  const transaction = await readDesktopRestoreTransaction(baseDir);
  if (transaction?.phase !== "staging") return;
  const registry = await readDesktopRestoreRegistry(baseDir);
  const expectedStage =
    registry.identity.kind === "nix"
      ? null
      : `${registry.identity.installPath}.crew-restore-${transaction.id}`;
  if (
    transaction.installationId !== registry.installationId ||
    transaction.stagePath !== expectedStage
  )
    throw new Error("Desktop staging installation binding changed.");
  for (const file of [
    transaction.stagePath,
    NodePath.join(paths(baseDir).directory, `controller.sh.${transaction.id}.tmp`),
  ]) {
    if (file === null) continue;
    try {
      const stat = await NodeFSP.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
        throw new Error("Desktop staging ownership changed.");
      await NodeFSP.unlink(file);
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
    }
  }
  await NodeFSP.unlink(paths(baseDir).transaction);
}

export async function recoverDesktopRestoreStaging(baseDir: string) {
  if ((await readDesktopRestoreTransaction(baseDir))?.phase !== "staging") return false;
  return withLock(baseDir, async () => true);
}

export async function desktopRestoreSchemaDigest(stateDir: string) {
  // Restore never opens a profile database writable and never invokes migrations.
  const databasePath = NodePath.join(stateDir, "statev2.sqlite");
  const NodeSqlite = await import("node:sqlite");
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const schema = database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    const migrations = database
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    if (schema.length === 0 || migrations.length === 0)
      throw new Error("Database compatibility is unknown.");
    return digest(JSON.stringify({ schema, migrations }));
  } finally {
    database.close();
  }
}

export function desktopRestoreArtifactPath(baseDir: string, artifact: Artifact) {
  if (artifact.nixStorePath !== null) {
    if (!/^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/.test(artifact.nixStorePath)) {
      throw new Error("Invalid Nix closure path.");
    }
    return NodePath.join(artifact.nixStorePath, "bin", "t3code-morrowbyte");
  }
  if (artifact.fileName !== `${artifact.sha256}.AppImage`)
    throw new Error("Invalid retained artifact path.");
  return NodePath.join(paths(baseDir).artifacts, artifact.fileName);
}

export async function verifyDesktopRestoreArtifact(baseDir: string, artifact: Artifact) {
  if (artifact.nixStorePath !== null) {
    const closure = await readNixRestoreClosure(artifact.nixStorePath, true);
    if (
      closure.sha256 !== artifact.sha256 ||
      closure.sizeBytes !== artifact.sizeBytes ||
      JSON.stringify(closure.members) !== JSON.stringify(artifact.nixClosure)
    )
      throw new Error("Nix closure identity changed.");
    return;
  }
  const file = await desktopRestoreFileDigest(desktopRestoreArtifactPath(baseDir, artifact));
  if (file.sha256 !== artifact.sha256 || file.sizeBytes !== artifact.sizeBytes)
    throw new Error("Retained desktop artifact is corrupt.");
}

export async function probeDesktopRestoreBuild(
  executable: string,
  baseDir: string,
  nixStorePath: string | null = null,
) {
  await NodeFSP.mkdir(paths(baseDir).directory, { recursive: true, mode: 0o700 });
  const launcher = renderDesktopRestoreLauncher({
    artifactPath: executable,
    baseDir,
    nixStorePath,
  });
  const { stdout } = await execFile(
    "/bin/sh",
    ["-c", launcher, "crew-restore-probe", "--crew-desktop-restore-probe"],
    {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", APPIMAGE_EXTRACT_AND_RUN: undefined },
    },
  );
  return decodeBuild(JSON.parse(stdout.trim()));
}

function compatible(current: Artifact, candidate: Artifact, schemaDigest: string) {
  if (!candidate.healthy || candidate.build === null || candidate.schemaDigest === null)
    return "This build has no verified restore and health contract.";
  if (current.build === null || !current.healthy)
    return "The current build has not completed its health check.";
  if (
    candidate.build.database !== current.build.database ||
    candidate.schemaDigest !== schemaDigest
  )
    return "The retained build cannot read this database schema.";
  if (candidate.build.events !== current.build.events)
    return "The retained build has a different event format.";
  if (candidate.build.profile !== current.build.profile)
    return "The retained build has a different profile or authentication format.";
  return null;
}

export async function listDesktopRestores({
  baseDir,
}: {
  readonly baseDir: string;
}): Promise<AppRestoreState> {
  const unavailable = (reason: string): AppRestoreState => ({
    component: "desktop",
    installationId: "",
    currentVersion: "",
    updateHold: false,
    maxVersions: 2,
    maxBytes: DEFAULT_MAX_BYTES,
    totalBytes: 0,
    candidates: [],
    unavailableReason: reason,
  });
  let registry;
  try {
    registry = await readDesktopRestoreRegistry(baseDir);
  } catch (cause) {
    return unavailable(
      isMissing(cause)
        ? "This desktop installation has not registered qualified restore support (Windows NSIS is currently unavailable)."
        : "Desktop restore metadata is invalid; no installation will be changed.",
    );
  }
  let schemaDigest: string | null = null;
  try {
    schemaDigest = await desktopRestoreSchemaDigest(registry.identity.stateDir);
  } catch {
    /* Unknown schemas are deliberately ineligible. */
  }
  const current = registry.artifacts.find((item) => item.sha256 === registry.currentHash);
  const transaction = await readDesktopRestoreTransaction(baseDir);
  const physical = await physicalRetention(baseDir, registry.identity);
  const candidates = await Promise.all(
    registry.artifacts
      .filter((item) => item.sha256 !== registry.currentHash)
      .map(async (item) => {
        let blockedReason =
          registry.identity.kind === "nsis"
            ? "Windows restore requires an independent verified installer controller."
            : schemaDigest === null || current === undefined
              ? "Current database compatibility is unknown."
              : compatible(current, item, schemaDigest);
        try {
          await verifyDesktopRestoreArtifact(baseDir, item);
        } catch {
          blockedReason = "The retained artifact or Nix closure failed integrity verification.";
        }
        return {
          version: item.version,
          sourceSha: item.sourceSha,
          sha256: item.sha256,
          sizeBytes: item.sizeBytes,
          blockedReason,
        };
      }),
  );
  return {
    component: "desktop",
    installationId: registry.installationId,
    currentVersion: registry.currentVersion,
    updateHold: registry.updateHold,
    maxVersions: registry.maxVersions,
    maxBytes: registry.maxBytes,
    totalBytes: physical.bytes,
    candidates,
    unavailableReason:
      transaction === null
        ? physical.count > registry.maxVersions || physical.bytes > registry.maxBytes
          ? "Physical desktop restore inventory exceeds its storage bounds."
          : null
        : transaction.pendingHealth
          ? "Original desktop bytes restored; pendingHealth requires a verified graphical start."
          : "An interrupted or active desktop restore must finish recovering first.",
  };
}

export async function isDesktopUpdateHeld({ baseDir }: { readonly baseDir: string }) {
  try {
    return (
      (await readDesktopRestoreRegistry(baseDir)).updateHold ||
      (await readDesktopRestoreTransaction(baseDir)) !== null
    );
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}

export async function releaseDesktopUpdateHold({ baseDir }: { readonly baseDir: string }) {
  return withLock(baseDir, async () => {
    const registry = await readDesktopRestoreRegistry(baseDir);
    if ((await readDesktopRestoreTransaction(baseDir)) !== null)
      throw new Error("Recover the pending desktop restore before resuming updates.");
    await writeDesktopRestoreJson(paths(baseDir).registry, { ...registry, updateHold: false });
    return listDesktopRestores({ baseDir });
  });
}

export interface RegisterDesktopRestoreInput {
  readonly baseDir: string;
  readonly identity: DesktopRestoreIdentity;
  readonly build: DesktopRestoreBuild;
  readonly maxVersions?: number;
  readonly maxBytes?: number;
}

export async function registerDesktopRestoreBuild(input: RegisterDesktopRestoreInput) {
  return withLock(input.baseDir, async () => {
    const build = decodeBuild(input.build);
    const identity = decodeIdentity(input.identity);
    if (
      identity.baseDir !== (await NodeFSP.realpath(input.baseDir)) ||
      ![identity.installPath, identity.stateDir, identity.userDataDir, identity.launcherPath].every(
        NodePath.isAbsolute,
      ) ||
      !identity.environmentId
    )
      throw new Error(
        "Desktop restore requires an exact installation, home, profile and environment identity.",
      );
    const installationId = digest(JSON.stringify(identity));
    let previous: DesktopRestoreRegistry | null = null;
    try {
      previous = await readDesktopRestoreRegistry(input.baseDir);
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
    }
    if (previous !== null && previous.installationId !== installationId)
      throw new Error("Desktop restore belongs to another installation or profile.");
    if ((await readDesktopRestoreTransaction(input.baseDir)) !== null) return;
    if (identity.kind === "nsis")
      throw new Error("Windows restore requires an independent verified installer controller.");
    const provenance =
      identity.kind === "nix" && identity.nixDataDir !== null
        ? await readNixRestoreProvenance(identity.nixDataDir, build.version)
        : null;
    if (
      identity.kind === "nix" &&
      (provenance === null ||
        identity.updaterPath === null ||
        (await NodeFSP.realpath(identity.installPath)) !== provenance.storePath)
    )
      throw new Error("Nix install lacks matching immutable provenance.");
    const actual = await probeDesktopRestoreBuild(
      identity.installPath,
      input.baseDir,
      provenance?.storePath ?? null,
    );
    if (JSON.stringify(actual) !== JSON.stringify(build))
      throw new Error("Installed desktop metadata does not match the running build.");
    const closure =
      provenance === null ? null : await readNixRestoreClosure(provenance.storePath, true);
    const artifact = closure ?? (await desktopRestoreFileDigest(identity.installPath));
    const maxVersions = input.maxVersions ?? previous?.maxVersions ?? 2;
    const maxBytes = input.maxBytes ?? previous?.maxBytes ?? DEFAULT_MAX_BYTES;
    if (
      !Number.isSafeInteger(maxVersions) ||
      maxVersions < 2 ||
      maxVersions > 10 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0
    )
      throw new Error("Invalid desktop restore storage limits.");
    await bindNixRestoreHome(identity);
    const reconciled = await reconcileRetention(input.baseDir, identity, installationId);
    const inventory = (reconciled?.inventory ?? previous?.artifacts ?? []).map(
      (item) => previous?.artifacts.find((registered) => registered.sha256 === item.sha256) ?? item,
    );
    const retained = inventory.filter((item) => item.sha256 !== artifact.sha256);
    const predecessor = retained.find((item) => item.sha256 === previous?.currentHash);
    const keep =
      predecessor === undefined
        ? retained.slice(-(maxVersions - 1))
        : [
            ...retained
              .filter((item) => item !== predecessor)
              .slice(-(maxVersions - 1))
              .slice(0, maxVersions - 2),
            predecessor,
          ];
    for (const item of keep) await verifyDesktopRestoreArtifact(input.baseDir, item);
    const totalBytes = retainedDesktopBytes([
      ...keep,
      { ...artifact, ...(closure === null ? {} : { nixClosure: closure.members }) },
    ]);
    if (totalBytes > maxBytes)
      throw new Error(
        "Desktop restore storage cap cannot retain the current build and its predecessor.",
      );
    const fileName = `${artifact.sha256}.${closure === null ? "AppImage" : "nix"}`;
    const next: Artifact = {
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      fileName,
      version: build.version,
      sourceSha: build.sourceSha,
      build,
      schemaDigest: null,
      healthy: false,
      nixStorePath: provenance?.storePath ?? null,
      ...(closure === null ? {} : { nixClosure: closure.members }),
    };
    const retentionFile = NodePath.join(paths(input.baseDir).directory, "retention.json");
    const evict = retained.filter((item) => !keep.includes(item));
    const cached = inventory.find((item) => item.sha256 === next.sha256);
    const destination = desktopRestoreArtifactPath(input.baseDir, next);
    if (closure === null && cached === undefined) {
      try {
        await NodeFSP.lstat(destination);
        throw new Error("An unowned desktop artifact occupies the retained path.");
      } catch (cause) {
        if (!isMissing(cause)) throw cause;
      }
    }
    const retention = {
      format: 1,
      installationId,
      inventory: cached === undefined ? keep : [...keep, cached],
      evict,
      copying: null,
    };
    await writeDesktopRestoreJson(retentionFile, retention);
    for (const old of evict) await removeOwnedArtifact(input.baseDir, identity, old);
    const physical = await physicalRetention(input.baseDir, identity);
    let exists = false;
    if (closure === null) {
      try {
        await NodeFSP.lstat(destination);
        exists = true;
      } catch (cause) {
        if (!isMissing(cause)) throw cause;
      }
      if (exists && cached === undefined)
        throw new Error("An unowned desktop artifact occupies the retained path.");
    } else exists = physical.roots.has(provenance!.storePath);
    const peakBytes =
      closure === null
        ? physical.bytes + (exists ? 0 : next.sizeBytes)
        : retainedDesktopBytes([...physical.files, next]);
    if (physical.count + (exists ? 0 : 1) > maxVersions || peakBytes > maxBytes)
      throw new Error("Physical desktop restore inventory and copy peak exceed the storage cap.");
    await admitStorage([input.baseDir], closure === null && !exists ? artifact.sizeBytes : 0);
    await writeDesktopRestoreJson(retentionFile, {
      ...retention,
      inventory: [...keep, cached ?? next],
      copying: cached === undefined ? next : null,
    });
    if (provenance !== null) {
      await retainNixRestoreRoot(
        NodePath.join(paths(input.baseDir).directory, "nix-roots", artifact.sha256),
        provenance.storePath,
      );
    } else if (!exists) {
      await NodeFSP.mkdir(paths(input.baseDir).artifacts, { recursive: true, mode: 0o700 });
      await NodeFSP.copyFile(
        identity.installPath,
        destination,
        NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
      );
      await NodeFSP.chmod(destination, 0o500);
      await syncFile(destination);
    }
    await verifyDesktopRestoreArtifact(input.baseDir, next);
    const alreadyHealthy = previous?.artifacts.find((item) => item.sha256 === artifact.sha256);
    const artifacts = [...keep, alreadyHealthy ?? next];
    await writeDesktopRestoreJson(paths(input.baseDir).registry, {
      format: 1,
      installationId,
      identity,
      currentVersion: build.version,
      currentHash: artifact.sha256,
      updateHold: previous?.updateHold ?? false,
      maxVersions,
      maxBytes,
      artifacts,
    });
    await writeDesktopRestoreJson(retentionFile, {
      ...retention,
      inventory: artifacts,
      evict: [],
      copying: null,
    });
  });
}

export async function markDesktopRestoreHealthy(input: {
  readonly baseDir: string;
  readonly build: DesktopRestoreBuild;
  readonly identity: DesktopRestoreIdentity;
}) {
  const registry = await readDesktopRestoreRegistry(input.baseDir);
  if (registry.installationId !== digest(JSON.stringify(input.identity)))
    throw new Error("Restored desktop started with a different identity.");
  const schemaDigest = await desktopRestoreSchemaDigest(input.identity.stateDir);
  const actual =
    input.identity.kind === "nix"
      ? await readNixRestoreClosure(await NodeFSP.realpath(input.identity.installPath), true)
      : await desktopRestoreFileDigest(input.identity.installPath);
  const transaction = await readDesktopRestoreTransaction(input.baseDir);
  if (transaction !== null) {
    const expected = transaction.phase === "recovering" ? transaction.from : transaction.to;
    if (
      actual.sha256 !== expected.sha256 ||
      input.build.version !== expected.version ||
      schemaDigest !== expected.schemaDigest ||
      JSON.stringify(input.build) !== JSON.stringify(expected.build)
    )
      throw new Error("Restored desktop failed its identity, version or schema health check.");
    await writeDesktopRestoreJson(
      NodePath.join(paths(input.baseDir).directory, `health-${transaction.id}.json`),
      {
        transactionId: transaction.id,
        installationId: registry.installationId,
        version: expected.version,
        sha256: actual.sha256,
        schemaDigest,
      },
    );
    return;
  }
  await withLock(input.baseDir, async () => {
    const latest = await readDesktopRestoreRegistry(input.baseDir);
    if (actual.sha256 !== latest.currentHash || input.build.version !== latest.currentVersion)
      throw new Error("Installed desktop identity changed before health registration.");
    await writeDesktopRestoreJson(paths(input.baseDir).registry, {
      ...latest,
      artifacts: latest.artifacts.map((item) =>
        item.sha256 === actual.sha256 ? { ...item, schemaDigest, healthy: true } : item,
      ),
    });
  });
}

export async function restoreDesktopVersion(
  input: AppRestoreInput & { readonly baseDir: string },
): Promise<AppRestoreResult> {
  try {
    return await withLock(input.baseDir, async () => {
      const registry = await readDesktopRestoreRegistry(input.baseDir);
      const state = await listDesktopRestores(input);
      if (state.unavailableReason !== null) throw new Error(state.unavailableReason);
      if (input.expectedCurrentVersion !== registry.currentVersion)
        throw new Error("The current desktop version changed. Refresh the version list.");
      const to = registry.artifacts.find(
        (item) => item.version === input.version && item.sha256 === input.expectedHash,
      );
      const from = registry.artifacts.find((item) => item.sha256 === registry.currentHash);
      const candidate = state.candidates.find(
        (item) => item.version === input.version && item.sha256 === input.expectedHash,
      );
      if (
        to === undefined ||
        from === undefined ||
        candidate === undefined ||
        candidate.blockedReason !== null
      )
        throw new Error(
          candidate?.blockedReason ?? "The selected desktop version or hash is unavailable.",
        );
      if (registry.identity.kind === "nsis")
        throw new Error("Windows restore requires an independent verified installer controller.");
      await verifyDesktopRestoreArtifact(input.baseDir, from);
      await verifyDesktopRestoreArtifact(input.baseDir, to);
      const graphics = await readDesktopRestoreLaunchContext(
        input.baseDir,
        registry.installationId,
      );
      const installed =
        registry.identity.kind === "nix"
          ? await readNixRestoreClosure(await NodeFSP.realpath(registry.identity.installPath), true)
          : await desktopRestoreFileDigest(registry.identity.installPath);
      if (installed.sha256 !== from.sha256)
        throw new Error("The installed desktop differs from the registered current version.");
      const actualBuild = await probeDesktopRestoreBuild(
        desktopRestoreArtifactPath(input.baseDir, to),
        input.baseDir,
        to.nixStorePath,
      );
      if (
        actualBuild.version !== to.version ||
        JSON.stringify(actualBuild) !== JSON.stringify(to.build)
      )
        throw new Error(
          "The retained artifact does not report its recorded version and compatibility contract.",
        );
      if (
        registry.artifacts.length > registry.maxVersions ||
        state.totalBytes > registry.maxBytes ||
        retainedDesktopBytes([from, to]) > registry.maxBytes
      )
        throw new Error("Desktop restore exceeds its storage bounds.");
      const physical = await physicalRetention(input.baseDir, registry.identity);
      if (
        physical.count > registry.maxVersions ||
        physical.bytes +
          (registry.identity.kind === "nix" ? 0 : Math.max(from.sizeBytes, to.sizeBytes)) >
          registry.maxBytes
      )
        throw new Error("Desktop restore staging peak exceeds its storage bounds.");
      await admitStorage(
        [input.baseDir, NodePath.dirname(registry.identity.installPath)],
        registry.identity.kind === "nix" ? 0 : Math.max(from.sizeBytes, to.sizeBytes),
      );
      const id = NodeCrypto.randomUUID();
      const stagePath =
        registry.identity.kind === "nix"
          ? null
          : `${registry.identity.installPath}.crew-restore-${id}`;
      const transaction: DesktopRestoreTransaction = {
        id,
        installationId: registry.installationId,
        from,
        to,
        phase: "staging",
        stagePath,
        originalHold: registry.updateHold,
        originalProcess: graphics.owner,
      };
      await writeDesktopRestoreJson(paths(input.baseDir).transaction, transaction);
      const controllerPath = NodePath.join(paths(input.baseDir).directory, "controller.sh");
      const controllerSource = renderDesktopRestoreLauncher({
        artifactPath: desktopRestoreArtifactPath(input.baseDir, from),
        baseDir: input.baseDir,
        nixStorePath: from.nixStorePath,
      });
      const temporaryController = `${controllerPath}.${id}.tmp`;
      const controllerFile = await NodeFSP.open(temporaryController, "wx", 0o700);
      try {
        await controllerFile.writeFile(controllerSource);
        await controllerFile.sync();
      } finally {
        await controllerFile.close();
      }
      await NodeFSP.rename(temporaryController, controllerPath);
      if (stagePath !== null) {
        await NodeFSP.copyFile(
          desktopRestoreArtifactPath(input.baseDir, to),
          stagePath,
          NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
        );
        await NodeFSP.chmod(stagePath, 0o755);
        await syncFile(stagePath);
        const staged = await desktopRestoreFileDigest(stagePath);
        if (staged.sha256 !== to.sha256) {
          await NodeFSP.rm(stagePath);
          throw new Error("Staged desktop artifact failed its hash check.");
        }
      } else {
        if (registry.identity.nixDataDir === null || registry.identity.updaterPath === null)
          throw new Error("Nix restore updater identity is incomplete.");
        for (const item of [from, to]) {
          const provenance = await readNixRestoreProvenance(
            registry.identity.nixDataDir,
            item.version,
          );
          if (provenance.storePath !== item.nixStorePath)
            throw new Error("Retained Nix provenance changed before stopping.");
        }
      }
      await writeDesktopRestoreJson(paths(input.baseDir).transaction, {
        ...transaction,
        phase: "prepared",
      });
      const child = NodeChildProcess.spawn(
        controllerPath,
        ["--crew-desktop-restore-controller", input.baseDir, id],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            APPIMAGE_EXTRACT_AND_RUN: undefined,
            T3CODE_HOME: input.baseDir,
          },
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      return {
        status: "scheduled",
        version: input.version,
        reason:
          "The independent controller will verify the restored desktop and recover the original on failure.",
      };
    });
  } catch (cause) {
    return {
      status: "failed",
      version: input.version,
      reason:
        cause instanceof Error && cause.message.length < 300
          ? cause.message
          : "Desktop restore failed before the installation could be changed.",
    };
  }
}

export {
  runDesktopRestoreController,
  startDesktopRestoreSession,
  recoverDesktopRestoreBeforeStartup,
} from "./desktopRestoreController.ts";
