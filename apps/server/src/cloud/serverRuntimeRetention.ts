// @effect-diagnostics nodeBuiltinImport:off -- The standalone launcher also enforces runtime storage limits.
// oxlint-disable t3code/no-global-process-runtime -- Process references protect native runtimes before server startup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  inspectServerRestore,
  serverRestoreLimits,
  serverRuntimeStorage,
} from "./serverRestoreStore.ts";
import { verifyServerRestoreRuntime } from "./serverRestoreManifest.ts";
import {
  isExactServiceVersion,
  parseServiceState,
  SERVICE_STATE_FILE,
  type ServiceState,
} from "./serviceProtocol.ts";

const candidateFile = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", "install-candidate.json");

interface RuntimeCandidate {
  readonly version: string;
  readonly directory: string;
  readonly pid: number;
}

async function writeCandidate(baseDir: string, candidate: RuntimeCandidate) {
  const text = JSON.stringify(candidate);
  if (Buffer.byteLength(text) > 16_384) throw new Error("Runtime candidate record is unsupported.");
  await NodeFSP.writeFile(candidateFile(baseDir), text, { flag: "wx", mode: 0o600 });
}

const readOptional = async (file: string) =>
  NodeFSP.readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });

export async function readServerRuntimeCandidate(
  baseDir: string,
): Promise<RuntimeCandidate | undefined> {
  const text = await readOptional(candidateFile(baseDir));
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text) > 16_384) throw new Error("Runtime candidate record is unsupported.");
  const value = JSON.parse(text) as Partial<RuntimeCandidate> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.version !== "string" ||
    !isExactServiceVersion(value.version) ||
    typeof value.directory !== "string" ||
    NodePath.dirname(value.directory) !== NodePath.resolve(baseDir, "runtime", "versions") ||
    (!NodePath.basename(value.directory).startsWith(".staging-") &&
      NodePath.basename(value.directory) !== value.version) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid === undefined ||
    value.pid <= 0
  )
    throw new Error("Runtime candidate record is unsupported.");
  return value as RuntimeCandidate;
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

const processOutput = (command: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (cause, stdout) => (cause === null ? resolve(stdout) : reject(cause)),
    );
  });

async function runtimeReferences(baseDir: string) {
  const references: string[] = [process.execPath];
  if (process.platform === "linux") {
    for (const pid of await NodeFSP.readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        references.push(await NodeFSP.readlink(`/proc/${pid}/exe`));
      } catch (cause) {
        if (["ENOENT", "ESRCH"].includes((cause as NodeJS.ErrnoException).code ?? "")) continue;
        const stat = await NodeFSP.stat(`/proc/${pid}`).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
          throw error;
        });
        if (stat === undefined || stat.uid !== process.getuid?.()) continue;
        references.push(await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8"));
      }
    }
  } else if (process.platform === "win32") {
    references.push(
      await processOutput("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
      ]),
    );
  } else {
    references.push(await processOutput("lsof", ["-nP", "-w", "-d", "txt", "-F", "n"]));
  }
  const recorded =
    (await readOptional(NodePath.join(baseDir, "runtime", "launchers")))
      ?.split(/\r?\n/)
      .filter((line) => line.trim().length > 0) ?? [];
  const launcherName = process.platform === "win32" ? "t3.cmd" : "t3";
  const directories = [
    process.env.T3CODE_INSTALL_BIN_DIR || NodePath.join(NodeOS.homedir(), ".local", "bin"),
    ...(process.env.PATH ?? process.env.Path ?? "").split(NodePath.delimiter),
  ].filter(NodePath.isAbsolute);
  for (const launcher of new Set([
    ...recorded,
    ...directories.map((directory) => NodePath.join(directory, launcherName)),
  ])) {
    try {
      if (process.platform === "win32") {
        const text = await NodeFSP.readFile(launcher, "utf8");
        const target = /^"([^"]+)"/m.exec(text)?.[1];
        if (target === undefined && recorded.includes(launcher))
          throw new Error("Recorded runtime launcher is unsupported.");
        if (target !== undefined) references.push(target);
      } else references.push(await NodeFSP.realpath(launcher));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  return references;
}

async function retentionSnapshot(baseDir: string, nextState?: ServiceState) {
  const versionsDir = NodePath.resolve(baseDir, "runtime", "versions");
  const realVersionsDir = await NodeFSP.realpath(versionsDir);
  const stateText = await readOptional(NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE));
  const state = nextState ?? (stateText === undefined ? undefined : parseServiceState(stateText));
  if (stateText !== undefined && state === undefined)
    throw new Error("Managed runtime state is unsupported.");
  const keep = new Set<string>();
  if (state !== undefined) {
    keep.add(state.activeVersion);
    if (state.update?.status === "pending" || state.update?.restore !== undefined) {
      keep.add(state.update.fromVersion);
      keep.add(state.update.targetVersion);
    }
    const inventory = await inspectServerRestore(baseDir, state);
    const predecessor = inventory.candidates.find((candidate) => candidate.blockedReason === null);
    if (predecessor !== undefined) keep.add(predecessor.version);
    else if (state.update?.status === "committed") keep.add(state.update.fromVersion);
  }
  const references = await runtimeReferences(baseDir);
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const referenced = (directory: string) => {
    const name = NodePath.basename(directory);
    const prefixes = [directory, NodePath.join(realVersionsDir, name)].map((value) =>
      fold(value + NodePath.sep),
    );
    return references.some((reference) =>
      prefixes.some((prefix) => fold(reference).includes(prefix)),
    );
  };
  return { versionsDir, state, keep, referenced };
}

async function cleanUnused(baseDir: string, reuseVersion?: string) {
  const snapshot = await retentionSnapshot(baseDir);
  if (reuseVersion !== undefined) snapshot.keep.add(reuseVersion);
  let candidate = await readServerRuntimeCandidate(baseDir);
  let settledCandidate = false;
  if (candidate !== undefined) {
    if (snapshot.state?.activeVersion === candidate.version) {
      settledCandidate = true;
      candidate = undefined;
    } else if (!processExists(candidate.pid) && snapshot.state?.update?.status !== "pending") {
      if (!snapshot.referenced(candidate.directory)) {
        const stat = await NodeFSP.lstat(candidate.directory).catch(
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return undefined;
            throw cause;
          },
        );
        if (stat?.isSymbolicLink())
          throw new Error("The owned runtime staging path was redirected.");
        if (stat !== undefined && NodePath.basename(candidate.directory).startsWith(".staging-"))
          await NodeFSP.rm(candidate.directory, { recursive: true });
        await NodeFSP.rm(candidateFile(baseDir));
        candidate = undefined;
      }
    }
    if (candidate !== undefined) snapshot.keep.add(candidate.version);
  }
  for (const name of (await serverRuntimeStorage(baseDir)).entries) {
    const version = name.startsWith(".pruned-") ? name.slice(".pruned-".length) : name;
    const directory = NodePath.join(snapshot.versionsDir, name);
    if (
      !isExactServiceVersion(version) ||
      snapshot.keep.has(version) ||
      snapshot.referenced(directory)
    )
      continue;
    if ((await NodeFSP.lstat(directory)).isSymbolicLink()) continue;
    if ((await readOptional(NodePath.join(directory, ".install-complete")))?.trim() !== version)
      continue;
    if (
      await verifyServerRestoreRuntime(directory, version).then(
        () => false,
        () => true,
      )
    )
      continue;
    const retired = NodePath.join(snapshot.versionsDir, `.pruned-${version}`);
    if (retired !== directory) {
      try {
        await NodeFSP.lstat(retired);
        throw new Error("An earlier runtime cleanup needs recovery.");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      await NodeFSP.rename(directory, retired);
    }
    await NodeFSP.rm(retired, { recursive: true });
  }
  if (settledCandidate) {
    const limits = await serverRestoreLimits(baseDir);
    const storage = await serverRuntimeStorage(baseDir);
    if (storage.entries.length <= limits.maxVersions && storage.totalBytes <= limits.maxBytes)
      await NodeFSP.rm(candidateFile(baseDir));
  }
  return { ...snapshot, candidate };
}

export async function acquireServerRuntimeRetention(baseDir: string) {
  await NodeFSP.mkdir(NodePath.join(baseDir, "runtime", "versions"), { recursive: true });
  const canonicalBaseDir = await NodeFSP.realpath(baseDir);
  const metadataBytes = (version: string) =>
    Buffer.byteLength(`${version}\n`) +
    2 *
      Buffer.byteLength(
        JSON.stringify({
          installationId: "0".repeat(64),
          baseDir: canonicalBaseDir,
          dbPath: NodePath.join(canonicalBaseDir, "userdata", "statev2.sqlite"),
          environmentId: "\u0000".repeat(256),
          version: "0".repeat(Math.max(255, version.length)),
          sha256: "0".repeat(64),
        }),
      );
  const db = new NodeSqlite.DatabaseSync(
    NodePath.join(baseDir, "runtime", "retention-owner.sqlite"),
  );
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (cause) {
    db.close();
    throw cause;
  }
  const check = async (additionalBytes = 0, temporarySlot = false) => {
    const limits = await serverRestoreLimits(baseDir);
    const storage = await serverRuntimeStorage(baseDir);
    if (
      !Number.isSafeInteger(additionalBytes) ||
      additionalBytes < 0 ||
      storage.entries.length > limits.maxVersions + Number(temporarySlot) ||
      storage.totalBytes + additionalBytes > limits.maxBytes
    ) {
      throw new Error("Runtime retention limit would be exceeded; no server was stopped.");
    }
    const disk = await NodeFSP.statfs(NodePath.join(baseDir, "runtime", "versions"), {
      bigint: true,
    });
    if (disk.bavail * disk.bsize < BigInt(additionalBytes))
      throw new Error(
        "Insufficient free space for the runtime transaction; no server was stopped.",
      );
    return limits;
  };
  return {
    release: () => db.close(),
    metadataBytes,
    clean: async () => {
      await cleanUnused(baseDir);
      await check();
    },
    admit: async (version: string, cached = false) => {
      if (!isExactServiceVersion(version)) throw new Error("Runtime version is unsupported.");
      const { candidate, state, versionsDir, referenced } = await cleanUnused(
        baseDir,
        cached ? version : undefined,
      );
      if (
        state?.update?.status === "pending" ||
        (candidate !== undefined && (!cached || candidate.version !== version))
      )
        throw new Error(
          "A runtime candidate or version transaction is already reserved; no server was stopped.",
        );
      const limits = await check(
        cached && version !== state?.activeVersion ? metadataBytes(version) : 0,
        cached && version !== state?.activeVersion,
      );
      if (cached && version === state?.activeVersion) return;
      let committedCount = 1;
      for (const name of (await serverRuntimeStorage(baseDir)).entries) {
        if (cached && name === version) continue;
        const directory = NodePath.join(versionsDir, name);
        if (
          name === state?.activeVersion ||
          (state?.update?.restore !== undefined && name === state.update.fromVersion) ||
          referenced(directory) ||
          !isExactServiceVersion(name)
        ) {
          committedCount++;
          continue;
        }
        const sentinel = await readOptional(NodePath.join(directory, ".install-complete"));
        const verified =
          sentinel?.trim() === name &&
          (await verifyServerRestoreRuntime(directory, name).then(
            () => true,
            () => false,
          ));
        if (!verified) committedCount++;
      }
      if (committedCount > limits.maxVersions)
        throw new Error(
          "Protected runtime references leave no committed version slot; no server was stopped.",
        );
      if (cached && candidate === undefined) {
        const value: RuntimeCandidate = {
          version,
          directory: NodePath.join(versionsDir, version),
          pid: process.pid,
        };
        await writeCandidate(baseDir, value);
      }
    },
    reserve: async (version: string, directory: string) => {
      const value: RuntimeCandidate = {
        version,
        directory: NodePath.resolve(directory),
        pid: process.pid,
      };
      await writeCandidate(baseDir, value);
      await check(0, true);
    },
    check: (additionalBytes: number) => check(additionalBytes, true),
    cancel: async (directory: string) => {
      const candidate = await readServerRuntimeCandidate(baseDir);
      if (candidate?.pid === process.pid && candidate.directory === NodePath.resolve(directory))
        await NodeFSP.rm(candidateFile(baseDir));
    },
  };
}

export async function cleanupServerRuntimeRetention(baseDir: string) {
  const retention = await acquireServerRuntimeRetention(baseDir);
  try {
    await retention.clean();
  } finally {
    retention.release();
  }
}

export async function assertServerRuntimeCommitFits(baseDir: string, nextState: ServiceState) {
  const candidate = await readServerRuntimeCandidate(baseDir);
  if (candidate === undefined) return;
  const retention = await acquireServerRuntimeRetention(baseDir);
  try {
    const limits = await retention.check(retention.metadataBytes(nextState.activeVersion));
    const { versionsDir, keep, referenced } = await retentionSnapshot(baseDir, nextState);
    if (candidate.version !== nextState.activeVersion && processExists(candidate.pid))
      keep.add(candidate.version);
    let committedCount = 0;
    for (const name of (await serverRuntimeStorage(baseDir)).entries) {
      const directory = NodePath.join(versionsDir, name);
      if (keep.has(name) || referenced(directory) || !isExactServiceVersion(name)) {
        committedCount++;
        continue;
      }
      const sentinel = await readOptional(NodePath.join(directory, ".install-complete"));
      const verified =
        sentinel?.trim() === name &&
        (await verifyServerRestoreRuntime(directory, name).then(
          () => true,
          () => false,
        ));
      if (!verified) committedCount++;
    }
    if (committedCount > limits.maxVersions)
      throw new Error("Protected runtime references exceed the committed retention limit.");
  } finally {
    retention.release();
  }
}
