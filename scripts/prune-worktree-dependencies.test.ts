// @effect-diagnostics nodeBuiltinImport:off -- Exercises the dependency-free cleanup entrypoint.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { pruneWorktreeDependencies } from "./prune-worktree-dependencies.ts";

async function fixture() {
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dependency-retention-"));
  const main = NodePath.join(temp, "main");
  const root = NodePath.join(temp, "worktree");
  await NodeFSP.mkdir(main);
  const git = (args: string[], cwd = main) =>
    NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" });
  git(["init", "-b", "main"]);
  await NodeFSP.writeFile(NodePath.join(main, "source.ts"), "original");
  git(["add", "."]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  git(["worktree", "add", "-b", "test", root]);
  await NodeFSP.mkdir(NodePath.join(root, "node_modules", ".pnpm"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "node_modules", ".modules.yaml"), "{}");
  await NodeFSP.writeFile(NodePath.join(root, "source.ts"), "uncommitted edit");
  await NodeFSP.writeFile(NodePath.join(root, ".env"), "private settings");
  await NodeFSP.mkdir(NodePath.join(root, ".t3"));
  await NodeFSP.writeFile(NodePath.join(root, ".t3", "state.sqlite"), "preserve state");
  return {
    root,
    main,
    git,
    [Symbol.asyncDispose]: () => NodeFSP.rm(temp, { recursive: true, force: true }),
  };
}

it("prunes only generated dependencies while preserving dirty source and private state", async () => {
  await using f = await fixture();
  expect(
    await pruneWorktreeDependencies(f.root, { platform: "linux", inUse: async () => false }),
  ).toMatch(/^removed:/);
  await expect(NodeFSP.stat(NodePath.join(f.root, "node_modules"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
  expect(await NodeFSP.readFile(NodePath.join(f.root, "source.ts"), "utf8")).toBe(
    "uncommitted edit",
  );
  expect(await NodeFSP.readFile(NodePath.join(f.root, ".env"), "utf8")).toBe("private settings");
  expect(await NodeFSP.readFile(NodePath.join(f.root, ".t3/state.sqlite"), "utf8")).toBe(
    "preserve state",
  );
});

it("keeps dependencies used by a process or another worktree", async () => {
  await using f = await fixture();
  expect(
    await pruneWorktreeDependencies(f.root, { platform: "linux", inUse: async () => true }),
  ).toBe("kept: process still uses worktree");
  await NodeFSP.symlink(
    NodePath.join(f.root, "node_modules"),
    NodePath.join(f.main, "node_modules"),
    "junction",
  );
  expect(
    await pruneWorktreeDependencies(f.root, { platform: "linux", inUse: async () => false }),
  ).toBe("kept: shared dependencies");
  expect((await NodeFSP.stat(NodePath.join(f.root, "node_modules"))).isDirectory()).toBe(true);
});

it("keeps dependencies shared through a package-local link or a package entry", async () => {
  await using f = await fixture();
  const packages = NodePath.join(f.main, "apps", "server", "node_modules");
  await NodeFSP.mkdir(NodePath.dirname(packages), { recursive: true });
  await NodeFSP.symlink(NodePath.join(f.root, "node_modules"), packages, "junction");
  expect(
    await pruneWorktreeDependencies(f.root, { platform: "linux", inUse: async () => false }),
  ).toBe("kept: shared dependencies");
  await NodeFSP.unlink(packages);
  await NodeFSP.mkdir(packages);
  await NodeFSP.mkdir(NodePath.join(f.root, "node_modules", "some-package"));
  await NodeFSP.symlink(
    NodePath.join(f.root, "node_modules", "some-package"),
    NodePath.join(packages, "shared"),
    "junction",
  );
  expect(
    await pruneWorktreeDependencies(f.root, { platform: "linux", inUse: async () => false }),
  ).toBe("kept: shared dependencies");
});

it("retains tracked dependencies and an active install", async () => {
  await using f = await fixture();
  const marker = NodePath.join(f.root, ".t3/setup-running");
  await NodeFSP.writeFile(marker, "other-owner");
  expect(
    await pruneWorktreeDependencies(f.root, { platform: "linux", inUse: async () => false }),
  ).toBe("kept: dependency operation active");
  expect(await NodeFSP.readFile(marker, "utf8")).toBe("other-owner");
  await NodeFSP.unlink(marker);
  f.git(["add", "node_modules/.modules.yaml"], f.root);
  expect(
    await pruneWorktreeDependencies(f.root, { platform: "linux", inUse: async () => false }),
  ).toBe("kept: tracked dependencies");
});

it("does not clean a main checkout or a platform without a process probe", async () => {
  await using f = await fixture();
  expect(await pruneWorktreeDependencies(f.main, { platform: "linux" })).toBe(
    "kept: main checkout",
  );
  expect(await pruneWorktreeDependencies(f.root, { platform: "win32" })).toBe(
    "kept: process inspection unavailable",
  );
});
