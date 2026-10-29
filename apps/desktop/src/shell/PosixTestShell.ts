// @effect-diagnostics nodeBuiltinImport:off - Test fixtures execute real POSIX shell commands.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

const platform = HostProcess.Platform.defaultValue();

const gitShell =
  platform === "win32"
    ? [
        ...(process.env.PATH ?? "")
          .split(NodePath.delimiter)
          .filter(Boolean)
          .flatMap((directory) => [
            NodePath.resolve(directory, ".."),
            NodePath.resolve(directory, "..", ".."),
          ]),
        NodePath.join(
          process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Local"),
          "Programs",
          "Git",
        ),
        NodePath.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git"),
        NodePath.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git"),
      ]
        .map((root) => NodePath.join(root, "usr", "bin", "sh.exe"))
        .find((candidate) => NodeFS.existsSync(candidate))
    : undefined;

export const shellPath = (path: string) =>
  platform === "win32"
    ? path
        .replaceAll("\\", "/")
        .replace(/^([a-z]):\//iu, (_, drive: string) => `/${drive.toLowerCase()}/`)
    : path;

export const runShell = (
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
) => {
  if (platform === "win32" && gitShell === undefined) {
    throw new Error("POSIX shell fixtures on Windows require an installed Git Bash.");
  }
  const env = options.env ?? process.env;
  const result = NodeChildProcess.spawnSync(gitShell ?? "/bin/sh", args, {
    ...options,
    encoding: "utf8",
    env: gitShell
      ? { ...env, PATH: `${NodePath.dirname(gitShell)}${NodePath.delimiter}${env.PATH ?? ""}` }
      : env,
  });
  if (result.error) throw result.error;
  return result;
};
