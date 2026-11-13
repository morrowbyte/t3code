// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

interface ControlRequest {
  readonly action: "status" | "pause" | "resume";
  readonly sessionId?: string;
}

interface ControlSession {
  readonly sessionId: string;
}

const controlRoot = () =>
  NodePath.join(NodeOS.tmpdir(), `t3-dev-replay-${process.getuid?.() ?? "user"}`);

const controlSocket = (directory: string) =>
  HostProcess.Platform.defaultValue() === "win32"
    ? `\\\\.\\pipe\\t3-dev-replay-${NodePath.basename(directory)}`
    : NodePath.join(directory, "control.sock");

function privateRoot(): string {
  const root = controlRoot();
  NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = NodeFS.lstatSync(root);
  if (
    !stat.isDirectory() ||
    (HostProcess.Platform.defaultValue() !== "win32" && (stat.mode & 0o077) !== 0) ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(`Replay control directory is not private: ${root}`);
  }
  return root;
}

export function startReplayControl(
  handle: (request: ControlRequest) => ReadonlyArray<ControlSession>,
  stop: () => void,
): () => void {
  const directory = NodeFS.mkdtempSync(NodePath.join(privateRoot(), "process-"));
  const socketPath = controlSocket(directory);
  NodeFS.writeFileSync(
    NodePath.join(directory, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const connections = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 4_096) return socket.destroy();
      if (!input.includes("\n")) return;
      socket.pause();
      try {
        const request = JSON.parse(input.slice(0, input.indexOf("\n"))) as ControlRequest;
        if (!["status", "pause", "resume"].includes(request.action))
          throw new Error("Unknown control action.");
        const sessions = handle(request);
        socket.end(`${JSON.stringify({ sessions, pid: process.pid, socket: socketPath })}\n`);
      } catch (error) {
        socket.end(
          `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
        );
      }
    });
  });
  const remove = () => NodeFS.rmSync(directory, { recursive: true, force: true });
  const cleanup = () => {
    stop();
    for (const connection of connections) connection.destroy();
    server.close();
    remove();
    process.removeListener("exit", remove);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  };
  const terminate = () => {
    cleanup();
    process.exitCode = 0;
    process.stdin.destroy();
  };
  server.on("error", (error) => {
    process.stderr.write(`Replay control unavailable: ${error.message}\n`);
    cleanup();
  });
  server.listen(socketPath);
  process.once("exit", remove);
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  return cleanup;
}

function requestControl(socketPath: string, request: ControlRequest) {
  return new Promise<{ sessions: ReadonlyArray<ControlSession>; pid: number; socket: string }>(
    (resolve, reject) => {
      const socket = NodeNet.createConnection(socketPath);
      let input = "";
      socket.setTimeout(5_000, () => socket.destroy(new Error("Replay control timed out.")));
      socket.once("error", reject);
      socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (input.length > 65_536) socket.destroy(new Error("Replay control response too large."));
      });
      socket.once("end", () => {
        try {
          const result = JSON.parse(input) as {
            error?: string;
            sessions: ReadonlyArray<ControlSession>;
            pid: number;
            socket: string;
          };
          if (result.error !== undefined) throw new Error(result.error);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    },
  );
}

// --control status lists live sessions; pause/resume require one exact ACP session id.
export async function runReplayControl(args: ReadonlyArray<string>): Promise<void> {
  const action = args[1];
  const sessionId = args.length === 4 && args[2] === "--session" ? args[3] : undefined;
  if (
    !["status", "pause", "resume"].includes(action ?? "") ||
    (args.length !== 2 && sessionId === undefined) ||
    (action !== "status" && !sessionId)
  ) {
    throw new Error("Usage: --control status [--session ID] | --control pause|resume --session ID");
  }
  const request = { action: "status" } as const;
  const processes = await Promise.all(
    NodeFS.readdirSync(privateRoot())
      .filter((name) => name.startsWith("process-"))
      .map(async (name) => {
        try {
          return await requestControl(controlSocket(NodePath.join(controlRoot(), name)), request);
        } catch (error) {
          // A killed process may leave its private directory; never delete another owner's files.
          if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
            return undefined;
          throw error;
        }
      }),
  );
  const sessions = processes.flatMap((entry) =>
    entry === undefined
      ? []
      : entry.sessions.map((session) => ({ ...session, pid: entry.pid, socket: entry.socket })),
  );
  if (sessionId === undefined) {
    process.stdout.write(`${JSON.stringify(sessions)}\n`);
    return;
  }
  const matches = sessions.filter((session) => session.sessionId === sessionId);
  if (matches.length !== 1)
    throw new Error(`Expected one live replay session ${sessionId}; found ${matches.length}.`);
  const result = await requestControl(matches[0]!.socket, {
    action: action as ControlRequest["action"],
    sessionId,
  });
  process.stdout.write(
    `${JSON.stringify({ ...result.sessions[0], pid: result.pid, socket: result.socket })}\n`,
  );
}
