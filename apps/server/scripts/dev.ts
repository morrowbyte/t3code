// @effect-diagnostics nodeBuiltinImport:off - the dev launcher needs only Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function devWatchArgs(serverDir: string, args: ReadonlyArray<string> = []) {
  const paths = [NodePath.join(serverDir, "src"), NodePath.join(serverDir, "package.json")];
  const packagesDir = NodePath.resolve(serverDir, "../../packages");
  // Snapshot packages at startup; watching their parent also catches test/build caches.
  for (const entry of NodeFS.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const packageDir = NodePath.join(packagesDir, entry.name);
    const manifest = NodePath.join(packageDir, "package.json");
    if (!NodeFS.statSync(manifest, { throwIfNoEntry: false })?.isFile()) continue;
    paths.push(manifest);
    const src = NodePath.join(packageDir, "src");
    if (NodeFS.statSync(src, { throwIfNoEntry: false })?.isDirectory()) paths.push(src);
  }

  return ["--watch", ...paths.map((path) => `--watch-path=${path}`), "src/bin.ts", ...args];
}

export function runDev(args: ReadonlyArray<string>, cwd: string) {
  const child = NodeChildProcess.spawn(process.execPath, args, { cwd, stdio: "inherit" });
  const cleanup = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const forward = () => {
      child.kill(signal);
    };
    process.on(signal, forward);
    return () => process.off(signal, forward);
  });
  child.once("error", (error) => {
    for (const remove of cleanup) remove();
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    for (const remove of cleanup) remove();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (import.meta.main) {
  const serverDir = NodePath.resolve(import.meta.dirname, "..");
  runDev(devWatchArgs(serverDir, process.argv.slice(2)), serverDir);
}
