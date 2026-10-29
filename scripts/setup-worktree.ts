// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { checkStorageAdmission } from "../packages/shared/src/node/storagePressure.ts";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const worktree = NodePath.dirname(import.meta.dirname);

const storageMessage = await checkStorageAdmission([worktree]);
if (storageMessage !== null) {
  throw new Error(`Cannot set up worktree: ${storageMessage}`);
}

// T3 runs setup in the background, so agents can start before it ends.
// `setup-running` holds this PID until setup ends with `setup-done` or
// `setup-failed`, so agents wait instead of racing it with their own `vp i`.
const markerDir = NodePath.join(worktree, ".t3");
const runningMarker = NodePath.join(markerDir, "setup-running");
const doneMarker = NodePath.join(markerDir, "setup-done");
const failedMarker = NodePath.join(markerDir, "setup-failed");
NodeFS.rmSync(doneMarker, { force: true });
NodeFS.rmSync(failedMarker, { force: true });
NodeFS.mkdirSync(markerDir, { recursive: true });
NodeFS.writeFileSync(runningMarker, `${process.pid}\n`);
let failureDetail = "";
process.on("uncaughtExceptionMonitor", (error) => {
  failureDetail = error.stack ?? String(error);
});
process.on("exit", (code) => {
  if (code === 0) NodeFS.writeFileSync(doneMarker, "");
  else NodeFS.writeFileSync(failedMarker, `Setup exited with code ${code}.\n${failureDetail}\n`);
  NodeFS.rmSync(runningMarker, { force: true });
});
// A cancelled setup must still leave a marker, or agents would wait forever.
// During install, the signal goes on to the installer and setup exits when the
// install output closes. Any child the shell leaves behind holds that output
// open, so no marker appears while `vp i` can still write node_modules.
let cancelSignal: NodeJS.Signals | undefined;
let activeInstall: NodeChildProcess.ChildProcess | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cancelSignal = signal;
    if (activeInstall) activeInstall.kill(signal);
    else process.exit(1);
  });
}

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Bootstrap runs before workspace dependencies exist.
const vpBinaryName = process.platform === "win32" ? "vp.exe" : "vp";
const vpHomes = [
  ...(process.env.VP_HOME ? [process.env.VP_HOME] : []),
  NodePath.join(
    process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local", "share"),
    "vite-plus",
  ),
  NodePath.join(NodeOS.homedir(), ".vite-plus"),
  ...[process.env.LOCALAPPDATA, process.env.APPDATA].flatMap((directory) =>
    directory ? [NodePath.join(directory, "vite-plus")] : [],
  ),
];
// A running desktop can retain the PATH from before Vite+ was installed.
const vpOnPath = (process.env.PATH ?? "")
  .split(NodePath.delimiter)
  .some((directory) =>
    (vpBinaryName === "vp.exe" ? ["vp.exe", "vp.cmd", "vp.bat"] : ["vp"]).some((name) =>
      NodeFS.existsSync(NodePath.join(directory, name)),
    ),
  );
const vpExecutable =
  (vpOnPath
    ? "vp"
    : vpHomes
        .map((directory) => NodePath.join(directory, "bin", vpBinaryName))
        .find((file) => NodeFS.existsSync(file))) ?? "vp";

const install = NodeChildProcess.spawn(vpExecutable, ["i", "--frozen-lockfile", "--", "--yes"], {
  cwd: worktree,
  shell: vpExecutable === "vp" && vpBinaryName === "vp.exe",
  stdio: ["ignore", "pipe", "pipe"],
});
activeInstall = install;
let installOutput = "";
for (const [source, target] of [
  [install.stdout, process.stdout],
  [install.stderr, process.stderr],
] as const) {
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    target.write(chunk);
    installOutput = (installOutput + chunk).slice(-8_000);
  });
}
const installStatus = await new Promise<number | null>((resolve) => install.on("close", resolve));
activeInstall = undefined;
if (installStatus !== 0 || cancelSignal) {
  failureDetail = cancelSignal
    ? `Cancelled by ${cancelSignal}.`
    : installOutput.trimEnd().split("\n").slice(-30).join("\n");
  process.exit(installStatus || 1);
}

// pnpm cannot clone or hardlink across filesystems, so a store on another
// device silently turns every worktree install into a full copy.
const storeDir: unknown = JSON.parse(
  NodeFS.readFileSync(NodePath.join(worktree, "node_modules", ".modules.yaml"), "utf8"),
).storeDir;
if (
  typeof storeDir === "string" &&
  NodeFS.statSync(storeDir).dev !== NodeFS.statSync(NodePath.join(worktree, "node_modules")).dev
) {
  process.stderr.write(
    [
      "",
      "WARNING: the pnpm store is on a different filesystem than this worktree.",
      `  store:    ${storeDir}`,
      `  worktree: ${worktree}`,
      "pnpm cannot hardlink or clone across filesystems, so it copied every package into node_modules.",
      "Fix: put the store on the worktree's filesystem, for example:",
      `  pnpm config set store-dir ${JSON.stringify(NodePath.join(NodePath.dirname(worktree), ".pnpm-store"))} --global`,
      "",
      "",
    ].join("\n"),
  );
}

// Worktrees link main-checkout env files; replace only symlinks so real files always survive.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}
