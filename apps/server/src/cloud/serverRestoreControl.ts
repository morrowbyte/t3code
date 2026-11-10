// @effect-diagnostics nodeBuiltinImport:off -- Local CLI transport also works without the server runtime.
// @effect-diagnostics globalTimers:off -- Bound local control connections independently of server startup.
// oxlint-disable t3code/no-global-process-runtime -- Standalone launcher transport has no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { AppRestoreInput, AppRestoreResult } from "@t3tools/contracts";

import { serverRestoreHash } from "./serverRestoreManifest.ts";

export type ServerRestoreControlRequest =
  | { readonly action: "restore"; readonly input: AppRestoreInput }
  | { readonly action: "release-hold" };

export async function acquireServiceLauncherLock(baseDir: string): Promise<() => void> {
  const directory = NodePath.join(baseDir, "runtime");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "launcher-owner.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (cause) {
    db.close();
    throw cause;
  }
  return () => db.close();
}

export async function acquireStoppedServerProfile(baseDir: string): Promise<() => void> {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata", "server-owner.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (cause) {
    db.close();
    throw cause;
  }
  return () => db.close();
}

export async function assertServerRestoreStopped(baseDir: string): Promise<void> {
  (await acquireStoppedServerProfile(baseDir))();
}

const controlPath = (baseDir: string) => NodePath.join(baseDir, "runtime", "restore-control.json");

export async function serveServerRestoreControl(
  baseDir: string,
  handle: (request: ServerRestoreControlRequest) => Promise<AppRestoreResult>,
): Promise<() => Promise<void>> {
  const canonical = await NodeFSP.realpath(baseDir);
  const key = serverRestoreHash(canonical).slice(0, 32);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\t3-restore-${key}`
      : NodePath.join(canonical, "runtime", "restore.sock");
  const token = NodeCrypto.randomBytes(32).toString("hex");
  if (process.platform !== "win32") await NodeFSP.rm(endpoint, { force: true });
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    socket.setTimeout(90_000, () => socket.destroy());
    let contents = "";
    socket.on("data", (chunk: string) => {
      contents += chunk;
      if (contents.length > 8192) {
        socket.destroy();
        return;
      }
      if (!contents.includes("\n")) return;
      socket.removeAllListeners("data");
      void (async () => {
        const raw: unknown = JSON.parse(contents.trim());
        if (
          typeof raw !== "object" ||
          raw === null ||
          !("token" in raw) ||
          raw.token !== token ||
          !("action" in raw)
        )
          throw new Error("Invalid local restore request.");
        let request: ServerRestoreControlRequest;
        if (raw.action === "release-hold") request = { action: "release-hold" };
        else if (
          raw.action === "restore" &&
          "input" in raw &&
          typeof raw.input === "object" &&
          raw.input !== null &&
          "version" in raw.input &&
          typeof raw.input.version === "string" &&
          "expectedCurrentVersion" in raw.input &&
          typeof raw.input.expectedCurrentVersion === "string" &&
          "expectedHash" in raw.input &&
          typeof raw.input.expectedHash === "string"
        ) {
          request = {
            action: "restore",
            input: {
              version: raw.input.version,
              expectedCurrentVersion: raw.input.expectedCurrentVersion,
              expectedHash: raw.input.expectedHash,
            },
          };
        } else throw new Error("Invalid local restore request.");
        socket.end(`${JSON.stringify(await handle(request))}\n`);
      })().catch(() =>
        socket.end(
          `${JSON.stringify({ status: "failed", version: "", reason: "Local restore request failed before handoff." })}\n`,
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    if (process.platform !== "win32") await NodeFSP.chmod(endpoint, 0o600);
    await NodeFSP.writeFile(controlPath(baseDir), JSON.stringify({ endpoint, token }), {
      mode: 0o600,
    });
  } catch (cause) {
    server.close();
    throw cause;
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(controlPath(baseDir), { force: true });
    if (process.platform !== "win32") await NodeFSP.rm(endpoint, { force: true });
  };
}

export async function requestServerRestoreControl(
  baseDir: string,
  request: ServerRestoreControlRequest,
): Promise<AppRestoreResult | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await NodeFSP.readFile(controlPath(baseDir), "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("endpoint" in raw) ||
    typeof raw.endpoint !== "string" ||
    !("token" in raw) ||
    typeof raw.token !== "string"
  )
    throw new Error("Invalid launcher control identity.");
  const { endpoint, token } = raw;
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(endpoint);
    const timer = setTimeout(
      () =>
        socket.destroy(
          new Error("Restore outcome is unknown; inspect managed state before retrying."),
        ),
      90_000,
    );
    socket.once("close", () => clearTimeout(timer));
    socket.once("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ECONNREFUSED") resolve(undefined);
      else reject(cause);
    });
    socket.setEncoding("utf8");
    let contents = "";
    socket.on("data", (chunk: string) => {
      contents += chunk;
      if (contents.length > 8192) socket.destroy(new Error("Invalid restore response."));
    });
    socket.once("end", () => {
      try {
        const reply: unknown = JSON.parse(contents.trim());
        if (
          typeof reply !== "object" ||
          reply === null ||
          !("status" in reply) ||
          (reply.status !== "scheduled" &&
            reply.status !== "restored" &&
            reply.status !== "failed") ||
          !("version" in reply) ||
          typeof reply.version !== "string" ||
          !("reason" in reply) ||
          (reply.reason !== null && typeof reply.reason !== "string")
        )
          throw new Error("Invalid restore response.");
        resolve({ status: reply.status, version: reply.version, reason: reply.reason });
      } catch (cause) {
        reject(cause);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...request, token })}\n`));
  });
}
