// @effect-diagnostics nodeBuiltinImport:off -- the setup script must run without installed dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

async function fixture(message: string | null, platform: NodeJS.Platform, snapshotRoot = false) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-setup-admission-"));
  const worktree = NodePath.join(directory, "worktree");
  if (snapshotRoot) NodeChildProcess.execFileSync("btrfs", ["subvolume", "create", worktree]);
  const scripts = NodePath.join(worktree, "scripts");
  const shared = NodePath.join(worktree, "packages/shared/src/node");
  const bin = NodePath.join(directory, "bin");
  const projectRoot = NodePath.join(directory, "main");
  await Promise.all([
    NodeFSP.mkdir(scripts, { recursive: true }),
    NodeFSP.mkdir(shared, { recursive: true }),
    NodeFSP.mkdir(bin),
    NodeFSP.mkdir(projectRoot),
  ]);
  if (platform !== "win32") {
    const privateEnv = NodePath.join(directory, "private.env");
    await NodeFSP.writeFile(privateEnv, "SETUP_FIXTURE=1\n");
    await NodeFSP.symlink(privateEnv, NodePath.join(projectRoot, ".env"));
  }
  await NodeFSP.copyFile(
    NodeURL.fileURLToPath(new URL("./setup-worktree.ts", import.meta.url)),
    NodePath.join(scripts, "setup-worktree.ts"),
  );
  await NodeFSP.copyFile(
    NodeURL.fileURLToPath(new URL("./dev-entry.ts", import.meta.url)),
    NodePath.join(scripts, "dev-entry.ts"),
  );
  await NodeFSP.writeFile(
    NodePath.join(scripts, "dev-runner.ts"),
    'import { writeFileSync } from "node:fs"; writeFileSync("dev-started", "yes");',
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
    directory,
    worktree,
    run: (args: string[] = [], entry = "setup-worktree.ts") =>
      new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [NodePath.join(scripts, entry), ...args],
          {
            cwd: worktree,
            env: {
              ...process.env,
              PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
              T3CODE_PROJECT_ROOT: projectRoot,
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
  it.live("prepares source-only worktrees without installing dependencies", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      yield* Effect.promise(async () => {
        await using test = await fixture(null, platform);
        expect(await test.run()).toEqual({ code: 0, stderr: "" });
        await expect(
          NodeFSP.stat(NodePath.join(test.worktree, "installer-started")),
        ).rejects.toHaveProperty("code", "ENOENT");
        await expect(
          NodeFSP.stat(NodePath.join(test.worktree, "node_modules")),
        ).rejects.toHaveProperty("code", "ENOENT");
        expect(await NodeFSP.readFile(NodePath.join(test.worktree, ".t3/setup-done"), "utf8")).toBe(
          "",
        );
      });
    }),
  );
  it.live("installs only on first development start and reuses the installation", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      yield* Effect.promise(async () => {
        await using test = await fixture(null, platform);
        expect((await test.run()).code).toBe(0);
        expect((await test.run(["dev"], "dev-entry.ts")).code).toBe(0);
        expect(await NodeFSP.readFile(NodePath.join(test.worktree, "dev-started"), "utf8")).toBe(
          "yes",
        );
        await NodeFSP.writeFile(NodePath.join(test.worktree, "installer-started"), "unchanged");
        expect((await test.run(["dev"], "dev-entry.ts")).code).toBe(0);
        expect(
          await NodeFSP.readFile(NodePath.join(test.worktree, "installer-started"), "utf8"),
        ).toBe("unchanged");
      });
    }),
  );

  it.live("does not race another dependency operation in the same worktree", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      yield* Effect.promise(async () => {
        await using test = await fixture(null, platform);
        await NodeFSP.mkdir(NodePath.join(test.worktree, ".t3"));
        const marker = NodePath.join(test.worktree, ".t3/setup-running");
        await NodeFSP.writeFile(marker, `${process.pid}\n`);
        expect((await test.run()).code).not.toBe(0);
        expect(await NodeFSP.readFile(marker, "utf8")).toBe(`${process.pid}\n`);
        await expect(
          NodeFSP.stat(NodePath.join(test.worktree, "installer-started")),
        ).rejects.toHaveProperty("code", "ENOENT");
      });
    }),
  );

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
        const result = await test.run(["--install"]);
        expect(result).toEqual({ code: 0, stderr: "" });
        if (platform !== "win32") {
          expect(await NodeFSP.readFile(NodePath.join(test.worktree, ".env"), "utf8")).toBe(
            "SETUP_FIXTURE=1\n",
          );
        }
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

// oxlint-disable-next-line t3code/no-global-process-runtime -- Native filesystem fixture selection runs during test collection.
it.skipIf(NodeOS.platform() !== "linux" || NodeFS.statfsSync(NodeOS.tmpdir()).type !== 0x9123683e)(
  "keeps newly installed dependencies out of enclosing Home snapshots while retaining source",
  async () => {
    await using test = await fixture(null, "linux", true);
    expect((await test.run(["--install"])).code).toBe(0);
    expect((await NodeFSP.stat(NodePath.join(test.worktree, "node_modules"))).ino).toBe(256);
    const snapshot = NodePath.join(test.directory, "snapshot");
    NodeChildProcess.execFileSync("btrfs", ["subvolume", "snapshot", test.worktree, snapshot]);
    expect(await NodeFSP.readFile(NodePath.join(snapshot, "package.json"), "utf8")).toBe(
      '{"type":"module"}',
    );
    expect(
      (await NodeFSP.stat(NodePath.join(test.worktree, "node_modules/.modules.yaml"))).isFile(),
    ).toBe(true);
    await expect(
      NodeFSP.stat(NodePath.join(snapshot, "node_modules/.modules.yaml")),
    ).rejects.toHaveProperty("code", "ENOENT");
  },
);
