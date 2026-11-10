// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Surviving installer controller must work without Electron services or a GUI.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import { resolveDesktopAppControlAddress } from "./desktopAppControl.ts";
import {
  desktopRestoreDirectory,
  desktopRestoreArtifactPath,
  desktopRestoreFileDigest,
  desktopRestoreProcessIdentity,
  desktopRestoreSchemaDigest,
  readDesktopRestoreRegistry,
  readDesktopRestoreTransaction,
  writeDesktopRestoreJson,
  verifyDesktopRestoreArtifact,
  type DesktopRestoreRegistry,
  type DesktopRestoreTransaction,
  type DesktopRestoreProcess,
} from "./desktopRestore.ts";
import { readNixRestoreClosure, switchNixRestore } from "./desktopRestoreNix.ts";
import {
  desktopRestoreLaunchEnvironment,
  readDesktopRestoreLaunchContext,
  saveDesktopRestoreLaunchContext,
} from "./desktopRestoreGraphics.ts";

const Session = Schema.Struct({
  pid: Schema.Number,
  processIdentity: Schema.String,
  installationId: Schema.String,
  token: Schema.String,
  address: Schema.String,
});
const decodeSession = Schema.decodeUnknownSync(Session);

const directoryFile = (baseDir: string, name: string) =>
  NodePath.join(desktopRestoreDirectory(baseDir), name);

const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

async function readSession(baseDir: string) {
  try {
    const file = directoryFile(baseDir, "session.json");
    const stat = await NodeFSP.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16 * 1024
    )
      throw new Error("Desktop restore session is not a private owned file.");
    return decodeSession(JSON.parse(await NodeFSP.readFile(file, "utf8")));
  } catch (cause) {
    if (missing(cause)) return null;
    throw cause;
  }
}

export async function startDesktopRestoreSession(input: {
  readonly baseDir: string;
  readonly appDataDirectory?: string;
  readonly quiesce: () => Promise<void>;
  readonly quit: () => void;
}) {
  const registry = await readDesktopRestoreRegistry(input.baseDir);
  if (registry.identity.kind === "nsis")
    throw new Error("Windows restore requires an independent verified installer controller.");
  const processIdentity = await desktopRestoreProcessIdentity(process.pid);
  if (processIdentity === null) throw new Error("Cannot prove the desktop process identity.");
  const previous = await readSession(input.baseDir);
  if (
    previous !== null &&
    (await desktopRestoreProcessIdentity(previous.pid)) === previous.processIdentity
  )
    throw new Error("This desktop restore installation already has a live owner.");
  const address = resolveDesktopAppControlAddress({
    stateDir: `${registry.identity.stateDir}/desktop-restore`,
    platform: "linux",
    tempDir: NodeOS.tmpdir(),
    userId: process.getuid?.(),
    joinPath: NodePath.join,
  });
  if (address.directory !== null)
    await NodeFSP.mkdir(address.directory, { recursive: true, mode: 0o700 });
  await NodeFSP.rm(address.address, { force: true });
  const token = NodeCrypto.randomBytes(32).toString("hex");
  let closing = false;
  const server = NodeNet.createServer((socket) => {
    socket.setTimeout(10_000, () => socket.destroy());
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      if (buffer.length > 4096) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      socket.pause();
      void (async () => {
        const request: unknown = JSON.parse(buffer.trim());
        if (
          typeof request !== "object" ||
          request === null ||
          !("token" in request) ||
          request.token !== token ||
          !("transactionId" in request)
        )
          throw new Error("Invalid restore shutdown request.");
        const transaction = await readDesktopRestoreTransaction(input.baseDir);
        if (
          transaction === null ||
          request.transactionId !== transaction.id ||
          transaction.installationId !== registry.installationId ||
          closing
        )
          throw new Error("Restore shutdown request is stale.");
        closing = true;
        await input.quiesce();
        socket.end("ready\n", input.quit);
      })().catch(() => {
        closing = false;
        socket.end("refused\n");
      });
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.address, resolve);
  });
  await NodeFSP.chmod(address.address, 0o600);
  await saveDesktopRestoreLaunchContext({
    baseDir: input.baseDir,
    installationId: registry.installationId,
    environment: process.env,
    appDataDirectory: input.appDataDirectory ?? NodePath.dirname(registry.identity.userDataDir),
  }).catch(async (cause) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(address.address, { force: true });
    throw cause;
  });
  await writeDesktopRestoreJson(directoryFile(input.baseDir, "session.json"), {
    pid: process.pid,
    processIdentity,
    installationId: registry.installationId,
    token,
    address: address.address,
  });
  return async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const current = await readSession(input.baseDir);
    if (current?.processIdentity === processIdentity) {
      await NodeFSP.rm(directoryFile(input.baseDir, "session.json"), { force: true });
      await NodeFSP.rm(address.address, { force: true });
    }
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function quiesceDesktop(baseDir: string, transaction: DesktopRestoreTransaction) {
  const latest = await readDesktopRestoreTransaction(baseDir);
  if (latest === null || latest.id !== transaction.id)
    throw new Error("Desktop restore shutdown transaction changed.");
  const expected = latest.launchedProcess ?? latest.originalProcess;
  if (expected === undefined) throw new Error("Desktop shutdown has no verified process identity.");
  const session = await readSession(baseDir);
  if (session !== null && session.installationId !== transaction.installationId)
    throw new Error("Desktop shutdown belongs to another installation.");
  const sessionAlive =
    session !== null &&
    (await desktopRestoreProcessIdentity(session.pid)) === session.processIdentity;
  if (sessionAlive && !(await belongsToLaunch(session, expected)))
    throw new Error("A different desktop session is active; restore cannot stop it.");
  await verifySingletonOwner(baseDir, expected, sessionAlive ? session : null);
  if (sessionAlive) {
    try {
      await requestShutdown(session, transaction);
      await waitForExit(session);
      await waitForExit(expected);
    } catch (cause) {
      if (latest.launchedProcess?.processIdentity !== session.processIdentity) throw cause;
      await stopOwnedDesktop(latest.launchedProcess);
    }
  }
  if ((await desktopRestoreProcessIdentity(expected.pid)) === expected.processIdentity) {
    if (latest.launchedProcess?.processIdentity !== expected.processIdentity)
      throw new Error("The registered desktop has no usable graceful shutdown endpoint.");
    await stopOwnedDesktop(expected);
  }
  await verifySingletonOwner(baseDir, expected, null);
}

async function belongsToLaunch(session: DesktopRestoreProcess, expected: DesktopRestoreProcess) {
  let pid = session.pid;
  for (let depth = 0; depth < 64 && pid > 1; depth += 1) {
    if (pid === expected.pid)
      return (await desktopRestoreProcessIdentity(pid)) === expected.processIdentity;
    try {
      const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      pid = Number(fields[1]);
    } catch (cause) {
      if (missing(cause)) return false;
      throw cause;
    }
  }
  return false;
}

async function verifySingletonOwner(
  baseDir: string,
  expected: DesktopRestoreProcess,
  session: DesktopRestoreProcess | null,
) {
  const registry = await readDesktopRestoreRegistry(baseDir);
  try {
    const link = await NodeFSP.readlink(
      NodePath.join(registry.identity.userDataDir, "SingletonLock"),
    );
    const separator = link.lastIndexOf("-");
    const pid = Number(link.slice(separator + 1));
    if (
      separator === -1 ||
      link.slice(0, separator) !== NodeOS.hostname() ||
      !Number.isSafeInteger(pid)
    )
      throw new Error("Desktop single-instance owner cannot be safely verified.");
    const identity = await desktopRestoreProcessIdentity(pid);
    if (
      identity !== null &&
      identity !== expected.processIdentity &&
      identity !== session?.processIdentity
    )
      throw new Error("An untracked desktop process still owns this profile.");
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
}

async function requestShutdown(
  session: typeof Session.Type,
  transaction: DesktopRestoreTransaction,
) {
  await new Promise<void>((resolve, reject) => {
    const socket = NodeNet.createConnection(session.address);
    socket.setTimeout(35_000, () =>
      socket.destroy(new Error("Desktop graceful shutdown timed out.")),
    );
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ token: session.token, transactionId: transaction.id })}\n`),
    );
    let response = "";
    socket.on("data", (data) => {
      response += data.toString("utf8");
      if (response.length > 128) socket.destroy();
    });
    socket.once("end", () =>
      response === "ready\n"
        ? resolve()
        : reject(new Error("Desktop refused its safe restore shutdown.")),
    );
    socket.once("error", reject);
  });
}

async function waitForExit(owner: DesktopRestoreProcess) {
  // Only an exact registered or spawn-captured process is observed.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await desktopRestoreProcessIdentity(owner.pid)) !== owner.processIdentity) return;
    await delay(100);
  }
  throw new Error("The exact desktop process did not exit gracefully.");
}

async function stopOwnedDesktop(owner: DesktopRestoreProcess) {
  if ((await desktopRestoreProcessIdentity(owner.pid)) !== owner.processIdentity) return;
  process.kill(owner.pid, "SIGTERM");
  await waitForExit(owner);
}

async function waitForHealth(
  baseDir: string,
  transaction: DesktopRestoreTransaction,
  version: string,
  sha256: string,
) {
  const file = directoryFile(baseDir, `health-${transaction.id}.json`);
  await new Promise<void>((resolve, reject) => {
    let inspecting = false;
    const close = () => {
      clearTimeout(timer);
      watcher.close();
    };
    const inspect = async () => {
      if (inspecting) return;
      inspecting = true;
      try {
        const receipt: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        if (
          typeof receipt !== "object" ||
          receipt === null ||
          !("transactionId" in receipt) ||
          receipt.transactionId !== transaction.id ||
          !("installationId" in receipt) ||
          receipt.installationId !== transaction.installationId ||
          !("version" in receipt) ||
          receipt.version !== version ||
          !("sha256" in receipt) ||
          receipt.sha256 !== sha256
        )
          throw new Error("Desktop health receipt did not match the restore.");
        close();
        resolve();
      } catch (cause) {
        if (!missing(cause)) {
          close();
          reject(cause);
        }
      } finally {
        inspecting = false;
      }
    };
    const watcher = NodeFS.watch(desktopRestoreDirectory(baseDir), () => {
      void inspect();
    });
    watcher.once("error", (cause) => {
      close();
      reject(cause);
    });
    const timer = setTimeout(() => {
      close();
      reject(new Error("Restored desktop did not report matching runtime health."));
    }, 90_000);
    void inspect();
  });
}

async function prepareDesktop(
  registry: DesktopRestoreRegistry,
  transaction: DesktopRestoreTransaction,
) {
  const graphics = await readDesktopRestoreLaunchContext(
    registry.identity.baseDir,
    registry.installationId,
  );
  const profileDirectory = NodePath.join(
    graphics.environment.XDG_CONFIG_HOME!,
    registry.identity.profileId === null ? "t3code-v2" : `t3code-${registry.identity.profileId}`,
  );
  if ((await NodeFSP.realpath(profileDirectory)) !== registry.identity.userDataDir)
    throw new Error("The desktop graphical context resolves to a different profile directory.");
  const expected = transaction.launchedProcess ?? transaction.originalProcess;
  if (expected === undefined)
    throw new Error("Desktop restore has no verified original process identity.");
  const session = await readSession(registry.identity.baseDir);
  if (
    session !== null &&
    (await desktopRestoreProcessIdentity(session.pid)) === session.processIdentity
  ) {
    if (
      session.installationId !== registry.installationId ||
      !(await belongsToLaunch(session, expected))
    )
      throw new Error("The desktop session changed before restore; refresh the version list.");
  } else if (
    transaction.launchedProcess === undefined &&
    graphics.owner.processIdentity !== expected.processIdentity
  )
    throw new Error("The desktop graphical session changed before restore.");
  await verifySingletonOwner(registry.identity.baseDir, expected, session);
}

async function launchDesktop(
  registry: DesktopRestoreRegistry,
  transaction: DesktopRestoreTransaction,
) {
  const graphics = await readDesktopRestoreLaunchContext(
    registry.identity.baseDir,
    registry.installationId,
  );
  // The launcher cannot run until its exact process identity has been durably recorded.
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    [
      "-c",
      'read -r start || exit 1; [ "$start" = launch ] || exit 1; exec "$@"',
      "desktop-restore",
      registry.identity.launcherPath,
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...desktopRestoreLaunchEnvironment(graphics),
        ELECTRON_RUN_AS_NODE: undefined,
        APPIMAGE_EXTRACT_AND_RUN: undefined,
        T3CODE_HOME: registry.identity.baseDir,
        T3CODE_DESKTOP_PROFILE: registry.identity.profileId ?? undefined,
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    const processIdentity =
      child.pid === undefined ? null : await desktopRestoreProcessIdentity(child.pid);
    if (processIdentity === null || child.pid === undefined)
      throw new Error("Cannot prove the launched desktop process identity.");
    await writeDesktopRestoreJson(directoryFile(registry.identity.baseDir, "transaction.json"), {
      ...transaction,
      launchedProcess: { pid: child.pid, processIdentity },
    });
    await new Promise<void>((resolve, reject) => {
      child.stdin.once("error", reject);
      child.stdin.end("launch\n", resolve);
    });
  } catch (cause) {
    child.stdin.destroy();
    throw cause;
  }
  child.unref();
}

export interface DesktopRestoreControllerRuntime {
  readonly prepare: (
    registry: DesktopRestoreRegistry,
    transaction: DesktopRestoreTransaction,
  ) => Promise<void>;
  readonly quiesce: (baseDir: string, transaction: DesktopRestoreTransaction) => Promise<void>;
  readonly launch: (
    registry: DesktopRestoreRegistry,
    transaction: DesktopRestoreTransaction,
  ) => Promise<void>;
  readonly health: (
    baseDir: string,
    transaction: DesktopRestoreTransaction,
    version: string,
    sha256: string,
  ) => Promise<void>;
}

export const desktopRestoreControllerRuntime: DesktopRestoreControllerRuntime = {
  prepare: prepareDesktop,
  quiesce: quiesceDesktop,
  launch: launchDesktop,
  health: waitForHealth,
};

async function replaceFromArtifact(
  baseDir: string,
  registry: DesktopRestoreRegistry,
  transaction: DesktopRestoreTransaction,
  recover: boolean,
) {
  const artifact = recover ? transaction.from : transaction.to;
  if (registry.identity.kind === "nix") {
    if (
      registry.identity.updaterPath === null ||
      registry.identity.nixDataDir === null ||
      artifact.nixStorePath === null ||
      transaction.from.nixStorePath === null
    )
      throw new Error("Nix restore identity is incomplete.");
    await verifyDesktopRestoreArtifact(baseDir, artifact);
    await switchNixRestore({
      updaterPath: NodePath.join(
        transaction.from.nixStorePath,
        "libexec",
        "t3code-morrowbyte-update",
      ),
      dataDir: registry.identity.nixDataDir,
      version: artifact.version,
      expectedStorePath: artifact.nixStorePath,
    });
    return;
  }
  const retained = desktopRestoreArtifactPath(baseDir, artifact);
  const integrity = await desktopRestoreFileDigest(retained);
  if (integrity.sha256 !== artifact.sha256 || integrity.sizeBytes !== artifact.sizeBytes)
    throw new Error("Retained desktop artifact changed during restore.");
  const stage = `${registry.identity.installPath}.crew-restore-${transaction.id}${recover ? "-recovery" : ""}`;
  if (!recover && transaction.stagePath !== stage)
    throw new Error("Desktop restore staging identity changed.");
  if (recover) {
    try {
      await NodeFSP.copyFile(
        retained,
        stage,
        NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
      );
    } catch (cause) {
      if (
        !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
      )
        throw cause;
    }
    await NodeFSP.chmod(stage, 0o755);
  }
  const staged = await desktopRestoreFileDigest(stage);
  if (staged.sha256 !== artifact.sha256 || staged.sizeBytes !== artifact.sizeBytes)
    throw new Error("Staged desktop artifact failed integrity verification.");
  const stagedFile = await NodeFSP.open(stage, "r");
  try {
    await stagedFile.sync();
  } finally {
    await stagedFile.close();
  }
  await NodeFSP.rename(stage, registry.identity.installPath);
  const directory = await NodeFSP.open(NodePath.dirname(registry.identity.installPath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function runDesktopRestoreController(
  input: { readonly baseDir: string; readonly transactionId: string },
  controller = desktopRestoreControllerRuntime,
) {
  const registry = await readDesktopRestoreRegistry(input.baseDir);
  const transaction = await readDesktopRestoreTransaction(input.baseDir);
  if (
    transaction === null ||
    transaction.id !== input.transactionId ||
    transaction.installationId !== registry.installationId ||
    registry.identity.kind === "nsis"
  )
    throw new Error("Desktop restore transaction does not belong to this installation.");
  const lock = directoryFile(input.baseDir, "controller.lock");
  const handle = await NodeFSP.open(lock, "wx", 0o600);
  let desktopStopped = false;
  let switchAttempted = false;
  try {
    const processIdentity = await desktopRestoreProcessIdentity(process.pid);
    if (processIdentity === null) throw new Error("Cannot prove the restore controller identity.");
    await handle.writeFile(processIdentity);
    if (transaction.phase !== "prepared")
      return await recoverTransaction(input.baseDir, registry, transaction, controller);
    await controller.prepare(registry, transaction);
    await controller.quiesce(input.baseDir, transaction);
    desktopStopped = true;
    const beforeSwitch =
      registry.identity.kind === "nix"
        ? await readNixRestoreClosure(await NodeFSP.realpath(registry.identity.installPath), true)
        : await desktopRestoreFileDigest(registry.identity.installPath);
    if (beforeSwitch.sha256 !== transaction.from.sha256)
      throw new Error("The installed desktop changed before selection; restore cannot continue.");
    const schemaDigest = await desktopRestoreSchemaDigest(registry.identity.stateDir);
    if (
      schemaDigest !== transaction.to.schemaDigest ||
      schemaDigest !== transaction.from.schemaDigest
    )
      throw new Error("Database schema changed before the desktop stopped.");
    await writeDesktopRestoreJson(directoryFile(input.baseDir, "transaction.json"), {
      ...transaction,
      phase: "switching",
    });
    switchAttempted = true;
    await replaceFromArtifact(input.baseDir, registry, transaction, false);
    const starting = { ...transaction, phase: "starting" as const };
    await writeDesktopRestoreJson(directoryFile(input.baseDir, "transaction.json"), starting);
    // The target sees the persistent hold before it can check or install another update.
    await writeDesktopRestoreJson(directoryFile(input.baseDir, "registry.json"), {
      ...registry,
      updateHold: true,
    });
    await controller.launch(registry, starting);
    await controller.health(input.baseDir, starting, transaction.to.version, transaction.to.sha256);
    const installed =
      registry.identity.kind === "nix"
        ? await readNixRestoreClosure(await NodeFSP.realpath(registry.identity.installPath), true)
        : await desktopRestoreFileDigest(registry.identity.installPath);
    if (installed.sha256 !== transaction.to.sha256)
      throw new Error("Installed desktop changed after its health check.");
    await writeDesktopRestoreJson(directoryFile(input.baseDir, "registry.json"), {
      ...registry,
      currentVersion: transaction.to.version,
      currentHash: transaction.to.sha256,
      updateHold: true,
    });
    await finishTransaction(input.baseDir, transaction);
  } catch (cause) {
    if (transaction.phase !== "prepared") throw cause;
    if (transaction.phase === "prepared" && !switchAttempted) {
      if (!desktopStopped) {
        await finishTransaction(input.baseDir, transaction);
        throw cause;
      }
      const current =
        registry.identity.kind === "nix"
          ? await readNixRestoreClosure(await NodeFSP.realpath(registry.identity.installPath), true)
          : await desktopRestoreFileDigest(registry.identity.installPath);
      if (current.sha256 !== transaction.from.sha256) {
        await finishTransaction(input.baseDir, transaction);
        throw cause;
      }
    }
    await recoverTransaction(input.baseDir, registry, transaction, controller);
    throw cause;
  } finally {
    await handle.close();
    await NodeFSP.unlink(lock);
  }
}

async function finishTransaction(baseDir: string, transaction: DesktopRestoreTransaction) {
  if (transaction.stagePath !== null) await NodeFSP.rm(transaction.stagePath, { force: true });
  await NodeFSP.rm(directoryFile(baseDir, `health-${transaction.id}.json`), { force: true });
  await NodeFSP.rm(directoryFile(baseDir, "transaction.json"), { force: true });
}

async function recoverTransaction(
  baseDir: string,
  registry: DesktopRestoreRegistry,
  transaction: DesktopRestoreTransaction,
  controller: DesktopRestoreControllerRuntime,
) {
  const latest = await readDesktopRestoreTransaction(baseDir);
  if (latest === null || latest.id !== transaction.id)
    throw new Error("Desktop restore recovery transaction changed.");
  transaction = latest;
  await controller.prepare(registry, transaction);
  await controller.quiesce(baseDir, transaction);
  const recovering = {
    ...transaction,
    phase: "recovering",
  } as const;
  await writeDesktopRestoreJson(directoryFile(baseDir, "transaction.json"), recovering);
  await NodeFSP.rm(directoryFile(baseDir, `health-${transaction.id}.json`), { force: true });
  let originalSelected = false;
  try {
    const installed =
      registry.identity.kind === "nix"
        ? await readNixRestoreClosure(await NodeFSP.realpath(registry.identity.installPath), true)
        : await desktopRestoreFileDigest(registry.identity.installPath);
    originalSelected = installed.sha256 === transaction.from.sha256;
  } catch {
    /* A missing or corrupt target still has a verified retained original. */
  }
  if (!originalSelected) await replaceFromArtifact(baseDir, registry, transaction, true);
  await writeDesktopRestoreJson(directoryFile(baseDir, "registry.json"), {
    ...registry,
    currentVersion: transaction.from.version,
    currentHash: transaction.from.sha256,
    updateHold: true,
  });
  await controller.launch(registry, recovering);
  await controller.health(baseDir, transaction, transaction.from.version, transaction.from.sha256);
  await finishTransaction(baseDir, transaction);
}

export async function recoverDesktopRestoreBeforeStartup({
  baseDir,
}: {
  readonly baseDir: string;
}) {
  const transaction = await readDesktopRestoreTransaction(baseDir);
  if (transaction === null) return false;
  const controllerLock = directoryFile(baseDir, "controller.lock");
  try {
    const owner = (await NodeFSP.readFile(controllerLock, "utf8")).split(":");
    const pid = Number(owner[0]);
    if (Number.isSafeInteger(pid)) {
      const identity = await desktopRestoreProcessIdentity(pid);
      if (identity !== null && (owner.length === 1 || identity === owner.join(":"))) return false;
    }
    await NodeFSP.unlink(controllerLock);
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
  await readDesktopRestoreRegistry(baseDir);
  await writeDesktopRestoreJson(directoryFile(baseDir, "transaction.json"), {
    ...transaction,
    phase: "recovering",
  });
  await verifyDesktopRestoreArtifact(baseDir, transaction.from);
  const controllerPath = directoryFile(baseDir, "controller.sh");
  const stat = await NodeFSP.lstat(controllerPath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("The independent desktop restore controller is unavailable.");
  const child = NodeChildProcess.spawn(
    controllerPath,
    ["--crew-desktop-restore-controller", baseDir, transaction.id],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        APPIMAGE_EXTRACT_AND_RUN: undefined,
        T3CODE_HOME: baseDir,
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return true;
}
