// @effect-diagnostics nodeBuiltinImport:off -- Offline launcher storage cannot depend on a loadable server runtime.
// oxlint-disable t3code/no-global-process-runtime -- Standalone launcher preflight uses the actual host executable.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { AppRestoreInput, AppRestoreState } from "@t3tools/contracts";

import {
  SERVER_RESTORE_DEFAULT_MAX_BYTES,
  serverRestoreDatabaseBlocker,
  serverRestoreIdentity,
  serverRestoreQualificationBlocker,
  serverUpdateHold,
  verifyServerRestoreRuntime,
  type ServerRestoreIdentity,
} from "./serverRestoreManifest.ts";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  type ServiceState,
} from "./serviceProtocol.ts";

const execFile = (command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      { env, timeout: 30_000, maxBuffer: 65_536, windowsHide: true, encoding: "utf8" },
      (error, stdout) =>
        error === null
          ? resolve(stdout)
          : reject(
              new Error("The retained executable failed version or profile preflight.", {
                cause: error,
              }),
            ),
    );
  });

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const target = NodePath.join(directory, entry.name);
    bytes += entry.isDirectory()
      ? await directoryBytes(target)
      : (await NodeFSP.lstat(target)).size;
  }
  return bytes;
}

export async function serverRuntimeStorage(baseDir: string) {
  const directory = NodePath.join(baseDir, "runtime", "versions");
  const entries = await NodeFSP.readdir(directory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return [];
    throw cause;
  });
  let totalBytes = 0;
  for (const entry of entries) {
    const target = NodePath.join(directory, entry);
    const stat = await NodeFSP.lstat(target);
    totalBytes += stat.isDirectory() ? await directoryBytes(target) : stat.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error("Runtime storage size is unsupported.");
  }
  return { entries, totalBytes };
}

export async function serverRestoreLimits(baseDir: string) {
  let text: string;
  try {
    text = await NodeFSP.readFile(NodePath.join(baseDir, "runtime", "restore-limits.json"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT")
      return { maxVersions: 2, maxBytes: SERVER_RESTORE_DEFAULT_MAX_BYTES };
    throw cause;
  }
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("maxVersions" in value) ||
    typeof value.maxVersions !== "number" ||
    !Number.isSafeInteger(value.maxVersions) ||
    value.maxVersions < 2 ||
    !("maxBytes" in value) ||
    typeof value.maxBytes !== "number" ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes <= 0
  ) {
    throw new Error("Invalid runtime retention limits.");
  }
  return { maxVersions: value.maxVersions, maxBytes: value.maxBytes };
}

export async function readServerRestoreState(baseDir: string) {
  const identity = await serverRestoreIdentity(baseDir);
  const state = parseServiceState(
    await NodeFSP.readFile(NodePath.join(identity.baseDir, "runtime", SERVICE_STATE_FILE), "utf8"),
  );
  if (state === undefined) throw new Error("The managed service state is unsupported.");
  return { identity, state };
}

export async function inspectServerRestore(
  baseDir: string,
  nextState?: ServiceState,
): Promise<AppRestoreState> {
  const { identity, state: recordedState } = await readServerRestoreState(baseDir);
  const state = nextState ?? recordedState;
  const limits = await serverRestoreLimits(identity.baseDir);
  const versionsDir = NodePath.join(identity.baseDir, "runtime", "versions");
  const storage = await serverRuntimeStorage(identity.baseDir);
  const versions = storage.entries
    .filter(isExactServiceVersion)
    .sort((a, b) => compareExactServiceVersions(b, a));
  const currentDir = NodePath.join(versionsDir, state.activeVersion);
  const currentSentinel = await NodeFSP.readFile(
    NodePath.join(currentDir, ".install-complete"),
    "utf8",
  ).catch(() => "");
  const current =
    currentSentinel.trim() !== state.activeVersion
      ? undefined
      : await verifyServerRestoreRuntime(currentDir, state.activeVersion).catch(() => undefined);
  const totalBytes = storage.totalBytes;
  const candidates: Array<AppRestoreState["candidates"][number]> = [];
  for (const version of versions) {
    const directory = NodePath.join(versionsDir, version);
    const redirected = (await NodeFSP.lstat(directory)).isSymbolicLink();
    const sizeBytes = redirected
      ? (await NodeFSP.lstat(directory)).size
      : await directoryBytes(directory);
    if (version === state.activeVersion) continue;
    const sentinel = await NodeFSP.readFile(
      NodePath.join(directory, ".install-complete"),
      "utf8",
    ).catch(() => "");
    const verified =
      redirected || sentinel.trim() !== version
        ? undefined
        : await verifyServerRestoreRuntime(directory, version).catch(() => undefined);
    let blockedReason: string | undefined;
    if (verified === undefined)
      blockedReason = "The retained runtime has no verified supported restore manifest.";
    else if (current === undefined)
      blockedReason = "The current runtime has no verified restore manifest.";
    else if (compareExactServiceVersions(version, state.activeVersion) >= 0)
      blockedReason = "Restore requires a qualified predecessor.";
    else if (
      verified.manifest.eventContract !== current.manifest.eventContract ||
      verified.manifest.profileContract !== current.manifest.profileContract
    )
      blockedReason = "The target has a different event or profile contract.";
    else {
      blockedReason = await serverRestoreQualificationBlocker(identity, version, verified.sha256);
      blockedReason ??= serverRestoreDatabaseBlocker(identity.dbPath, verified.manifest);
    }
    candidates.push({
      version,
      sourceSha: verified?.manifest.sourceSha ?? null,
      sha256: verified?.sha256 ?? "",
      sizeBytes,
      blockedReason: blockedReason ?? null,
    });
  }
  const candidateRecord = await NodeFSP.lstat(
    NodePath.join(identity.baseDir, "runtime", "install-candidate.json"),
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  const unavailableReason =
    state.update?.status === "pending"
      ? "A managed version transaction is still pending."
      : candidateRecord !== undefined
        ? `A runtime candidate record awaits cleanup (${storage.entries.length} entries; committed limit ${limits.maxVersions}, at most one temporary transaction slot). Staging and archive bytes count toward the ${limits.maxBytes}-byte limit.`
        : storage.entries.length > limits.maxVersions || totalBytes > limits.maxBytes
          ? "Retained runtimes exceed the configured limit; no server was stopped."
          : current === undefined
            ? "The current runtime has no verified supported restore manifest."
            : null;
  return {
    component: "server",
    installationId: identity.installationId,
    currentVersion: state.activeVersion,
    updateHold: await serverUpdateHold(identity.baseDir),
    ...limits,
    totalBytes,
    unavailableReason,
    candidates,
  };
}

export async function preflightServerRestore(
  baseDir: string,
  input: AppRestoreInput,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<{ readonly identity: ServerRestoreIdentity; readonly state: ServiceState }> {
  const inventory = await inspectServerRestore(baseDir);
  if (inventory.unavailableReason !== null) throw new Error(inventory.unavailableReason);
  if (inventory.currentVersion !== input.expectedCurrentVersion)
    throw new Error("The active version changed; list restore candidates again.");
  const candidate = inventory.candidates.find(({ version }) => version === input.version);
  if (
    candidate === undefined ||
    candidate.blockedReason !== null ||
    candidate.sha256 !== input.expectedHash
  ) {
    throw new Error(
      candidate?.blockedReason ?? "The requested retained runtime hash does not match.",
    );
  }
  const { identity, state } = await readServerRestoreState(baseDir);
  const executable = NodePath.join(
    identity.baseDir,
    "runtime",
    "versions",
    input.version,
    process.platform === "win32" ? "t3.exe" : "t3",
  );
  const env = { ...environment, T3CODE_HOME: identity.baseDir, T3CODE_NO_BROWSER: "1" };
  const actual = await execFile(executable, ["--version"], env);
  if (actual.trim() !== input.version)
    throw new Error("The retained executable reports a different version.");
  const result = await execFile(
    executable,
    [
      "__service-preflight",
      "--database-path",
      identity.dbPath,
      "--launcher-protocol",
      String(SERVICE_LAUNCHER_PROTOCOL),
    ],
    env,
  );
  const reply: unknown = JSON.parse(result.trim());
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("status" in reply) ||
    reply.status !== "ready" ||
    !("version" in reply) ||
    reply.version !== input.version ||
    !("launcherProtocol" in reply) ||
    reply.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL
  ) {
    throw new Error("The retained executable did not pass same-profile preflight.");
  }
  if ((await serverRestoreIdentity(identity.baseDir)).installationId !== identity.installationId)
    throw new Error("The installation identity changed during preflight.");
  const latest = await readServerRestoreState(baseDir);
  if (
    latest.state.activeVersion !== state.activeVersion ||
    latest.state.update?.status === "pending"
  )
    throw new Error("A concurrent version transaction changed the installation.");
  return { identity, state };
}
