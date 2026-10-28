// @effect-diagnostics nodeBuiltinImport:off - verifies watch coverage against a real filesystem layout.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import { assert, it } from "@effect/vitest";

import { devWatchArgs } from "./dev.ts";

it("watches server and package sources/manifests without covering generated caches", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 dev watch "));
  try {
    const sources = [
      "apps/server/src/bin.ts",
      "apps/server/package.json",
      "packages/client-runtime/src/state/thread.ts",
      "packages/client-runtime/package.json",
      "packages/source-only/src/index.ts",
      "packages/source-only/package.json",
      "packages/manifest-only/package.json",
    ];
    const caches = [
      "packages/client-runtime/node_modules/.vite-temp/vite.config.ts.timestamp-123.mjs",
      "packages/client-runtime/node_modules/.vite/vitest/results.json",
      "packages/client-runtime/dist/index.js",
      "packages/client-runtime/.cache/test-results.json",
      "packages/client-runtime/coverage/index.html",
      "packages/node_modules/nested/src/index.ts",
      "packages/node_modules/package.json",
      "packages/.cache/src/index.ts",
      "packages/.cache/package.json",
      "packages/no-manifest/src/index.ts",
    ];
    for (const file of [...sources, ...caches]) {
      const absolute = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
      NodeFS.writeFileSync(absolute, "");
    }

    const args = devWatchArgs(NodePath.join(root, "apps/server"), ["--port", "12345"]);
    const watchPaths = args
      .filter((arg) => arg.startsWith("--watch-path="))
      .map((arg) => arg.slice("--watch-path=".length));
    const covered = (relative: string) => {
      const file = NodePath.join(root, relative);
      return watchPaths.some(
        (path) =>
          file === path ||
          (NodeFS.statSync(path).isDirectory() && file.startsWith(`${path}${NodePath.sep}`)),
      );
    };

    for (const file of sources) assert.equal(covered(file), true, `source: ${file}`);
    for (const file of caches) assert.equal(covered(file), false, `cache: ${file}`);
    assert.equal(args[0], "--watch");
    assert.deepEqual(args.slice(-3), ["src/bin.ts", "--port", "12345"]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function spawnDev(args: ReadonlyArray<string>) {
  const moduleUrl = new URL("./dev.ts", import.meta.url).href;
  return NodeChildProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { runDev } from ${JSON.stringify(moduleUrl)};
       runDev(${JSON.stringify(args)}, ${JSON.stringify(process.cwd())});`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

it("preserves the child exit code and inherited output", async () => {
  const child = spawnDev(["--eval", 'process.stdout.write("done"); process.exitCode = 23;']);
  const closed = NodeEvents.once(child, "close");
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  assert.deepEqual(await closed, [23, null]);
  assert.equal(output, "done");
});

it.each(["SIGINT", "SIGTERM"] as const)("forwards %s and exits with the child", async (signal) => {
  const child = spawnDev(["--eval", 'process.stdin.resume(); process.stdout.write("ready");']);
  const closed = NodeEvents.once(child, "close");
  try {
    const [ready] = await NodeEvents.once(child.stdout, "data");
    assert.equal(String(ready), "ready");
    assert.equal(child.kill(signal), true);
    assert.deepEqual(await closed, [null, signal]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});
