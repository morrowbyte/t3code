// @effect-diagnostics nodeBuiltinImport:off - Explicit local ACP queue transport; no shell, editor activation or file contents.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

export interface EditorFileChange {
  readonly path: string;
  readonly diff: string;
}

const inside = (root: string, file: string) => {
  const relative = Path.relative(root, file);
  return (
    relative === "" ||
    (!Path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${Path.sep}`))
  );
};

export function firstChangedLine(diff: string): number {
  const rows = diff.split("\n");
  let current: number | undefined;
  let first: number | undefined;
  for (const row of rows) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(row);
    if (hunk) {
      current = Math.max(1, Number(hunk[1]));
      first ??= current;
      continue;
    }
    if (current === undefined) continue;
    if (row.startsWith("+") && !row.startsWith("+++")) return current;
    if (row.startsWith("-") && !row.startsWith("---")) return current;
    if (row.startsWith(" ")) current++;
  }
  return first ?? 1;
}

/** Opt-in research seam. The selected thread and project must both match the live Zed connection. */
export async function publishEditorFileChanges(input: {
  readonly queueDirectory: string;
  readonly selectedThreadId: string;
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly itemId: string;
  readonly changes: ReadonlyArray<EditorFileChange>;
}): Promise<{ readonly queued: number; readonly skipped: number }> {
  if (input.threadId !== input.selectedThreadId)
    return { queued: 0, skipped: input.changes.length };
  const queue = await Fs.realpath(input.queueDirectory);
  const connectionFile = Path.join(queue, "connection.json");
  const file = await Fs.open(connectionFile, "r");
  let connection: unknown;
  try {
    const stat = await file.stat();
    if (stat.size > 4096 || Date.now() - stat.mtimeMs > 6000)
      throw new Error("Editor connection is stale");
    connection = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  if (
    typeof connection !== "object" ||
    connection === null ||
    !("version" in connection) ||
    connection.version !== 1 ||
    !("project" in connection) ||
    typeof connection.project !== "string" ||
    !("sessionId" in connection) ||
    typeof connection.sessionId !== "string" ||
    !("ready" in connection) ||
    connection.ready !== true ||
    !("expiresUnixMs" in connection) ||
    typeof connection.expiresUnixMs !== "number" ||
    connection.expiresUnixMs < Date.now()
  ) {
    throw new Error("No current editor connection");
  }
  const project = await Fs.realpath(connection.project);
  const workspace = await Fs.realpath(input.workspaceRoot);
  if (!inside(workspace, project) && !inside(project, workspace))
    throw new Error("Editor project is outside the selected workspace");
  let queued = 0,
    skipped = 0;
  for (const change of input.changes.slice(0, 64)) {
    let absolute: string;
    try {
      absolute = await Fs.realpath(Path.resolve(workspace, change.path));
    } catch {
      skipped++;
      continue;
    }
    const relative = Path.relative(project, absolute);
    if (
      !relative ||
      !inside(workspace, absolute) ||
      !inside(project, absolute) ||
      relative.split(/[\\/]/u).some((part) => part.startsWith(".")) ||
      !/\.(?:[cm]?js|jsx|ts|tsx|json|md|txt|css|html|rs|py|sql|sh|ps1|nix|go|cs|ya?ml|toml|xml)$/u.test(
        relative,
      ) ||
      !(await Fs.stat(absolute)).isFile()
    ) {
      skipped++;
      continue;
    }
    const line = firstChangedLine(change.diff);
    const id =
      "t3-" +
      Crypto.createHash("sha256")
        .update(JSON.stringify([input.threadId, input.itemId, absolute]))
        .digest("hex")
        .slice(0, 40);
    const target = Path.join(queue, `${id}.request.json`);
    const temporary = Path.join(queue, `${id}.${Crypto.randomUUID()}.tmp`);
    const request = {
      id,
      op: "follow",
      sessionId: connection.sessionId,
      path: relative,
      line: Math.max(1, line),
    };
    await Fs.writeFile(temporary, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    // Hard-link publication is exclusive and atomic on the same local filesystem.
    // A duplicate provider notification never replaces a previous request or receipt.
    try {
      await Fs.link(temporary, target);
      queued++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") skipped++;
      else throw error;
    } finally {
      await Fs.unlink(temporary);
    }
  }
  return { queued, skipped: skipped + Math.max(0, input.changes.length - 64) };
}
