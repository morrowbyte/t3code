// @effect-diagnostics nodeBuiltinImport:off -- the setup script must run without installed dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

async function fixture(message: string | null, platform: NodeJS.Platform) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-setup-admission-"));
  const worktree = NodePath.join(directory, "worktree");
  const scripts = NodePath.join(worktree, "scripts");
  const shared = NodePath.join(worktree, "packages/shared/src/node");
  const bin = NodePath.join(directory, "bin");
  await Promise.all([
    NodeFSP.mkdir(scripts, { recursive: true }),
    NodeFSP.mkdir(shared, { recursive: true }),
    NodeFSP.mkdir(bin),
  ]);
  await NodeFSP.copyFile(
    NodeURL.fileURLToPath(new URL("./setup-worktree.ts", import.meta.url)),
    NodePath.join(scripts, "setup-worktree.ts"),
  );
  await NodeFSP.writeFile(NodePath.join(worktree, "package.json"), '{"type":"module"}');
  await NodeFSP.writeFile(
    NodePath.join(shared, "storagePressure.ts"),
    `export async function checkStorageAdmission() { return ${JSON.stringify(message)}; }`,
  );
  const installer = NodePath.join(bin, "installer.cjs");
  await NodeFSP.writeFile(
    installer,
    `const fs = require("node:fs"); fs.writeFileSync("installer-started", JSON.stringify(process.argv.slice(2))); fs.mkdirSync("node_modules", {recursive:true}); fs.writeFileSync("node_modules/.modules.yaml", "{}");`,
  );
  const launcher = platform === "win32" ? "vp.cmd" : "vp";
  const command = `"${process.execPath}" "${installer}"`;
  await NodeFSP.writeFile(
    NodePath.join(bin, launcher),
    platform === "win32" ? `@${command} %*\r\n` : `#!/bin/sh\n${command} "$@"\n`,
    { mode: 0o755 },
  );
  return {
    worktree,
    run: () =>
      new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [NodePath.join(scripts, "setup-worktree.ts")],
          {
            cwd: worktree,
            env: {
              ...process.env,
              PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
              T3CODE_PROJECT_ROOT: worktree,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stdout.resume();
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      }),
    [Symbol.asyncDispose]: () => NodeFSP.rm(directory, { recursive: true, force: true }),
  };
}

describe("worktree installer storage admission", () => {
  it.live("blocks before marker mkdir and installer start on critical storage pressure", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      yield* Effect.promise(async () => {
        const message = "Btrfs metadata is critically full. Free disk space and try again.";
        await using test = await fixture(message, platform);
        const result = await test.run();
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(message);
        await expect(
          NodeFSP.stat(NodePath.join(test.worktree, "installer-started")),
        ).rejects.toHaveProperty("code", "ENOENT");
        await expect(NodeFSP.stat(NodePath.join(test.worktree, ".t3"))).rejects.toHaveProperty(
          "code",
          "ENOENT",
        );
      });
    }),
  );

  it.live("keeps the locked install and success markers when admission succeeds", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      yield* Effect.promise(async () => {
        await using test = await fixture(null, platform);
        const result = await test.run();
        expect(result).toEqual({ code: 0, stderr: "" });
        expect(
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(test.worktree, "installer-started"), "utf8"),
          ),
        ).toEqual(["i", "--frozen-lockfile", "--", "--yes"]);
        expect(await NodeFSP.readFile(NodePath.join(test.worktree, ".t3/setup-done"), "utf8")).toBe(
          "",
        );
        await expect(
          NodeFSP.stat(NodePath.join(test.worktree, ".t3/setup-running")),
        ).rejects.toHaveProperty("code", "ENOENT");
        await expect(
          NodeFSP.stat(NodePath.join(test.worktree, ".t3/setup-failed")),
        ).rejects.toHaveProperty("code", "ENOENT");
      });
    }),
  );
});
