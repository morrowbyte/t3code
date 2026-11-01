// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off -- Cleanup must run without installed dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const inside = (root: string, target: string) =>
  target === root || target.startsWith(`${root}${NodePath.sep}`);
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

// Some desktop credential services disallow same-user ptrace. Use only already-granted,
// non-interactive permissions to read /proc; deletion always runs as the ordinary user.
async function readProcess(path: string, kind: "link" | "text" | "directory") {
  if (!/^\/proc\/\d+\/(?:cwd|exe|maps|status|fd(?:\/\d+)?)$/u.test(path)) {
    throw new Error("Invalid process inspection path");
  }
  try {
    if (kind === "link") return await NodeFSP.readlink(path);
    if (kind === "directory") return await NodeFSP.readdir(path);
    return await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error.code === "EACCES" || error.code === "EPERM")
      )
    )
      throw error;
    const command = kind === "link" ? "readlink" : kind === "directory" ? "ls" : "cat";
    const args = kind === "directory" ? ["-1", "--", path] : ["--", path];
    const value = NodeChildProcess.execFileSync("sudo", ["-n", command, ...args], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return kind === "directory"
      ? value.trim().split("\n").filter(Boolean)
      : kind === "link"
        ? value.trimEnd()
        : value;
  }
}

async function referencedByProcess(root: string) {
  const ignored = new Set([process.pid]);
  let parent = process.ppid;
  while (parent > 1 && !ignored.has(parent)) {
    ignored.add(parent);
    const status = (await readProcess(`/proc/${parent}/status`, "text")) as string;
    parent = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1] ?? 0);
  }
  for (const name of await NodeFSP.readdir("/proc")) {
    if (!/^\d+$/u.test(name) || ignored.has(Number(name))) continue;
    const proc = `/proc/${name}`;
    try {
      // Only this user's processes can own these user-created development artifacts.
      if ((await NodeFSP.stat(proc)).uid !== process.getuid!()) continue;
      const targets = [
        (await readProcess(`${proc}/cwd`, "link")) as string,
        (await readProcess(`${proc}/exe`, "link")) as string,
      ];
      for (const fd of (await readProcess(`${proc}/fd`, "directory")) as string[]) {
        try {
          if (/^\d+$/u.test(fd))
            targets.push((await readProcess(`${proc}/fd/${fd}`, "link")) as string);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      if (targets.some((target) => inside(root, target))) return true;
      if (((await readProcess(`${proc}/maps`, "text")) as string).includes(`${root}/`)) return true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return false;
}

// Inspect source links and public dependency links, including package-local installs.
// A pnpm store's real directories belong to that store; its consumers are public links.
async function hasSharedDependencies(worktree: string, modules: string, deadline: number) {
  const pending = [worktree];
  let inspected = 0;
  while (pending.length > 0) {
    const directories = pending.splice(-8);
    const batches = await Promise.all(
      directories.map(async (directory) => ({
        directory,
        entries: await NodeFSP.readdir(directory, { withFileTypes: true }),
      })),
    );
    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        if (++inspected > 100_000 || Date.now() >= deadline)
          throw new Error("Dependency ownership scan limit reached; retained for a later pass");
        const path = NodePath.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            if (inside(modules, await NodeFSP.realpath(path))) return true;
          } catch (error) {
            if (!missing(error)) throw error;
          }
        } else if (entry.isDirectory() && entry.name !== ".git" && entry.name !== ".pnpm") {
          pending.push(path);
        }
      }
    }
  }
  return false;
}

export async function pruneWorktreeDependencies(
  root: string,
  options: {
    platform?: NodeJS.Platform;
    worktrees?: readonly string[];
    inUse?: (root: string) => Promise<boolean>;
    inspectionTimeoutMs?: number;
  } = {},
) {
  // Other platforms retain artifacts until they have an equivalent process-ownership probe.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before dependency installation; callers inject platform in tests.
  if ((options.platform ?? process.platform) !== "linux")
    return "kept: process inspection unavailable";
  root = await NodeFSP.realpath(root);
  const modules = NodePath.join(root, "node_modules");
  const receipt = NodePath.join(root, ".t3", "dependency-prune.json");
  let resuming = false;
  try {
    const saved = JSON.parse(await NodeFSP.readFile(receipt, "utf8"));
    if (saved.version !== 1 || saved.modules !== modules)
      throw new Error("Invalid dependency cleanup receipt");
    resuming = true;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    if (!(await NodeFSP.lstat(NodePath.join(root, ".git"))).isFile()) return "kept: main checkout";
    if (!(await NodeFSP.lstat(modules)).isDirectory()) return "kept: shared dependencies";
    if (!resuming && !(await NodeFSP.lstat(NodePath.join(modules, ".pnpm"))).isDirectory())
      return "kept: shared or unknown store";
    if (!resuming && !(await NodeFSP.lstat(NodePath.join(modules, ".modules.yaml"))).isFile())
      return "kept: unknown dependencies";
  } catch (error) {
    if (missing(error)) return "kept: no managed dependencies";
    throw error;
  }
  if (
    NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", "node_modules"], {
      cwd: root,
      encoding: "utf8",
    }).length > 0
  ) {
    return "kept: tracked dependencies";
  }
  const worktrees =
    options.worktrees ??
    NodeChildProcess.execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter((row) => row.startsWith("worktree "))
      .map((row) => row.slice(9));
  const peers = worktrees.filter((worktree) => worktree !== root);
  // Most shared installs are root links. Check every peer before walking any source tree.
  for (const worktree of peers) {
    try {
      if (inside(modules, await NodeFSP.realpath(NodePath.join(worktree, "node_modules"))))
        return "kept: shared dependencies";
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  // Do not turn a safe cleanup into unbounded disk I/O on a large worktree fleet.
  // An incomplete inspection always retains the dependencies.
  const deadline = Date.now() + (options.inspectionTimeoutMs ?? 10_000);
  for (const worktree of peers) {
    if (await hasSharedDependencies(worktree, modules, deadline))
      return "kept: shared dependencies";
  }

  const marker = NodePath.join(root, ".t3", "setup-running");
  await NodeFSP.mkdir(NodePath.dirname(marker), { recursive: true });
  try {
    await NodeFSP.writeFile(marker, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const owner = Number((await NodeFSP.readFile(marker, "utf8")).trim());
    if (!Number.isSafeInteger(owner) || owner <= 0) return "kept: dependency operation active";
    try {
      process.kill(owner, 0);
      return "kept: dependency operation active";
    } catch (ownerError) {
      if (!(ownerError instanceof Error && "code" in ownerError && ownerError.code === "ESRCH"))
        throw ownerError;
    }
    await NodeFSP.unlink(marker);
    await NodeFSP.writeFile(marker, `${process.pid}\n`, { flag: "wx" });
  }
  try {
    if (await (options.inUse ?? referencedByProcess)(root))
      return "kept: process still uses worktree";
    await NodeFSP.writeFile(receipt, JSON.stringify({ version: 1, modules }), {
      flag: resuming ? "w" : "wx",
    });
    await NodeFSP.rm(modules, { recursive: true });
    await NodeFSP.unlink(receipt);
    return "removed: regenerable dependencies; source and state retained";
  } finally {
    await NodeFSP.unlink(marker);
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    console.log(await pruneWorktreeDependencies(NodePath.dirname(import.meta.dirname)));
  } catch (error) {
    console.error(
      `Dependencies retained: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
