// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - ACP stdio and private local queue boundary.
import * as Fs from "node:fs";
import * as Path from "node:path";
import * as Crypto from "node:crypto";
import * as Readline from "node:readline";

/** View-only ACP agent. It sends file locations; it never reads or writes editor file contents. */
export async function runEditorFollowAcp(
  projectArgument: string,
  queueArgument: string,
  streams: {
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  if (!projectArgument || !queueArgument)
    throw new Error("Explicit project and private queue paths required.");
  const project = Fs.realpathSync(projectArgument),
    queue = Fs.realpathSync(queueArgument);
  const bridgeId = Crypto.randomUUID(),
    lock = Path.join(queue, "bridge.lock.json");
  Fs.writeFileSync(lock, JSON.stringify({ bridgeId, pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  const input = Readline.createInterface({
    input: streams.input ?? process.stdin,
    crlfDelay: Infinity,
  });
  const output = streams.output ?? process.stdout;
  const send = (row: unknown) => {
    output.write(JSON.stringify(row) + "\n");
  };
  const sessions = new Set<string>(),
    processed = new Set<string>();
  let initialized = false,
    session: string | undefined,
    prompt: string | number | undefined,
    failed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const notify = (update: unknown) =>
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update } });
  const connection = Path.join(queue, "connection.json");
  const publish = () => {
    const temporary = Path.join(queue, `connection-${bridgeId}.tmp`);
    Fs.writeFileSync(
      temporary,
      JSON.stringify({
        version: 1,
        bridgeId,
        pid: process.pid,
        project,
        sessionId: session,
        ready: prompt !== undefined && !failed,
        expiresUnixMs: Date.now() + 6000,
      }),
      { flag: "wx", mode: 0o600 },
    );
    Fs.renameSync(temporary, connection);
  };
  const stop = (stopReason: "cancelled" | "end_turn") => {
    if (prompt !== undefined) send({ jsonrpc: "2.0", id: prompt, result: { stopReason } });
    prompt = undefined;
    clearInterval(heartbeat);
    heartbeat = undefined;
    publish();
  };
  const resolveLocation = (relative: unknown) => {
    if (
      typeof relative !== "string" ||
      relative.length > 4096 ||
      relative.includes("\0") ||
      Path.isAbsolute(relative)
    )
      throw new Error("Relative code path required.");
    const file = Fs.realpathSync(Path.resolve(project, relative)),
      tail = Path.relative(project, file);
    if (
      !tail ||
      Path.isAbsolute(tail) ||
      tail === ".." ||
      tail.startsWith(`..${Path.sep}`) ||
      tail.split(/[\\/]/u).some((part) => part.startsWith(".")) ||
      !/\.(?:[cm]?js|jsx|ts|tsx|json|md|txt|css|html|rs|py|sql|sh|ps1|nix|go|cs|ya?ml|toml|xml)$/u.test(
        tail,
      )
    )
      throw new Error("File is outside the selected code project.");
    const stat = Fs.statSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Unsupported file.");
    return file;
  };
  const drain = () => {
    if (prompt === undefined || failed) return;
    for (const name of Fs.readdirSync(queue)
      .filter((name) => /^[a-z0-9-]+\.request\.json$/u.test(name))
      .sort()) {
      if (processed.has(name)) continue;
      processed.add(name);
      const receipt = Path.join(queue, name.replace(".request.", ".receipt."));
      if (Fs.existsSync(receipt)) continue;
      const claimed = Path.join(queue, name.replace(".request.", ".claimed."));
      let requestId: string | undefined;
      try {
        if (Fs.existsSync(claimed))
          throw new Error("Prior request has unknown delivery; no replay.");
        const file = Path.join(queue, name),
          requestStat = Fs.lstatSync(file);
        if (!requestStat.isFile() || requestStat.isSymbolicLink() || requestStat.size > 8192)
          throw new Error("Unsupported follow request file.");
        const raw = Fs.readFileSync(file, "utf8"),
          request: unknown = JSON.parse(raw);
        if (
          typeof request !== "object" ||
          request === null ||
          !("id" in request) ||
          typeof request.id !== "string" ||
          !/^[a-z0-9-]+$/u.test(request.id) ||
          name !== `${request.id}.request.json` ||
          !("sessionId" in request) ||
          request.sessionId !== session ||
          !("op" in request) ||
          !["follow", "finish"].includes(String(request.op))
        )
          throw new Error("Request identity, session or operation refused.");
        requestId = request.id;
        if (request.op === "finish") {
          Fs.writeFileSync(claimed, JSON.stringify({ bridgeId, requestId }), {
            flag: "wx",
            mode: 0o600,
          });
          stop("end_turn");
        } else {
          if (
            !("path" in request) ||
            !("line" in request) ||
            typeof request.line !== "number" ||
            !Number.isInteger(request.line) ||
            request.line < 1 ||
            request.line > 4294967295
          )
            throw new Error("One-based source location required.");
          const file = resolveLocation(request.path),
            locations = [{ path: file, line: request.line - 1 }],
            toolCallId = `follow-${requestId}`;
          Fs.writeFileSync(claimed, JSON.stringify({ bridgeId, requestId }), {
            flag: "wx",
            mode: 0o600,
          });
          notify({
            sessionUpdate: "tool_call",
            toolCallId,
            title: `T3: ${request.path}`,
            kind: "read",
            status: "in_progress",
            locations,
          });
          notify({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", locations });
        }
        Fs.writeFileSync(
          receipt,
          JSON.stringify({
            id: requestId,
            ok: true,
            notificationOnly: true,
            fileRead: false,
            fileWrite: false,
          }),
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        if (!Fs.existsSync(receipt))
          Fs.writeFileSync(receipt, JSON.stringify({ id: requestId, ok: false, noReplay: true }), {
            flag: "wx",
            mode: 0o600,
          });
        failed = true;
        publish();
        notify({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Dateifolge wegen ungültiger oder unklarer Zustellung gestoppt. Neue Verbindung erforderlich.",
          },
        });
        break;
      }
      if (prompt === undefined) break;
    }
  };
  const watcher = Fs.watch(queue, drain);
  try {
    for await (const line of input) {
      let row:
        | { id?: string | number; method?: string; params?: Record<string, unknown> }
        | undefined;
      try {
        if (line.length > 65536) throw new Error("RPC frame too large.");
        row = JSON.parse(line);
        if (!row || typeof row !== "object") throw new Error("Invalid RPC.");
        if (row.method === "initialize") {
          if (initialized || row.params?.protocolVersion !== 1)
            throw new Error("ACP v1 initialization required.");
          initialized = true;
          send({
            jsonrpc: "2.0",
            id: row.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: false,
                promptCapabilities: { image: false, audio: false, embeddedContext: false },
              },
              agentInfo: {
                name: "t3-editor-follow",
                title: "T3 Follow · view only",
                version: "0.1.0",
              },
              authMethods: [],
            },
          });
        } else if (row.method === "session/new") {
          if (
            !initialized ||
            typeof row.params?.cwd !== "string" ||
            Fs.realpathSync(row.params.cwd) !== project
          )
            throw new Error("Selected project differs.");
          const id = Crypto.randomUUID();
          sessions.add(id);
          send({ jsonrpc: "2.0", id: row.id, result: { sessionId: id } });
        } else if (row.method === "session/prompt") {
          if (
            !initialized ||
            typeof row.params?.sessionId !== "string" ||
            !sessions.has(row.params.sessionId) ||
            prompt !== undefined ||
            failed ||
            row.id === undefined
          )
            throw new Error("Invalid, busy or failed session.");
          session = row.params.sessionId;
          prompt = row.id;
          publish();
          heartbeat = setInterval(publish, 2000);
          notify({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "T3-Dateifolge bereit. Änderungen in T3 beauftragen. Stop beendet nur diese Editoransicht; den T3-Auftrag in T3 stoppen.",
            },
          });
          drain();
        } else if (row.method === "session/cancel") {
          if (row.params?.sessionId === session) stop("cancelled");
        } else if (row.id !== undefined) throw new Error("Unsupported view-only ACP request.");
      } catch {
        if (row?.id !== undefined)
          send({
            jsonrpc: "2.0",
            id: row.id,
            error: { code: -32602, message: "Invalid view-only ACP request." },
          });
      }
    }
  } finally {
    watcher.close();
    clearInterval(heartbeat);
    prompt = undefined;
    if (session !== undefined) publish();
    const current: unknown = JSON.parse(Fs.readFileSync(lock, "utf8"));
    if (
      typeof current === "object" &&
      current !== null &&
      "bridgeId" in current &&
      current.bridgeId === bridgeId
    )
      Fs.unlinkSync(lock);
  }
}
