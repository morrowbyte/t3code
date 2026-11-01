// @effect-diagnostics nodeBuiltinImport:off -- Bootstraps development before dependencies exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.dirname(import.meta.dirname);

const run = (script: string, args: string[] = []) =>
  new Promise<number>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodePath.join(root, "scripts", script), ...args],
      {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      },
    );
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const forward = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of forward) process.on(signal, handler);
    child.once("error", reject);
    child.once("close", (code) => {
      for (const [signal, handler] of forward) process.off(signal, handler);
      resolve(code ?? 1);
    });
  });

const marker = NodePath.join(root, ".t3", "setup-running");
if (NodeFS.existsSync(marker)) {
  const code = await run("setup-worktree.ts", ["--prepare"]);
  if (code !== 0) process.exit(code);
}

// The setup marker also represents source-only preparation; inspect the actual installation.
if (!NodeFS.existsSync(NodePath.join(root, "node_modules", ".modules.yaml"))) {
  const code = await run("setup-worktree.ts", ["--install"]);
  if (code !== 0) process.exit(code);
}
process.exitCode = await run("dev-runner.ts", process.argv.slice(2));
