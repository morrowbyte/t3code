// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Real ACP stream and owned temporary queue checks.
import { expect, it } from "vite-plus/test";
import * as Fs from "node:fs/promises";
import { watch } from "node:fs";
import { EventEmitter } from "node:events";
import * as Path from "node:path";
import * as Os from "node:os";
import { PassThrough } from "node:stream";
import { runEditorFollowAcp } from "./EditorFollowAcp.ts";

interface RpcRow {
  id?: number;
  method?: string;
  result?: { sessionId?: string; stopReason?: string };
  params?: {
    sessionId?: string;
    update?: { sessionUpdate?: string; locations?: ReadonlyArray<{ path: string; line: number }> };
  };
}

function receiveEvent<T>(read: () => T | undefined, events: EventEmitter): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = read();
      if (value !== undefined) {
        clearTimeout(timer);
        events.off("row", check);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      events.off("row", check);
      reject(new Error("ACP response deadline exceeded"));
    }, 1500);
    events.on("row", check);
    check();
  });
}
async function fixture() {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "t3-follow-acp-")),
    project = Path.join(root, "project"),
    queue = Path.join(root, "queue");
  await Fs.mkdir(project);
  await Fs.mkdir(queue);
  await Fs.writeFile(Path.join(project, "a.ts"), "first\nsecond\nthird\nfourth\n");
  await Fs.writeFile(Path.join(root, "outside.ts"), "outside");
  await Fs.writeFile(Path.join(project, ".private.ts"), "private");
  const input = new PassThrough(),
    output = new PassThrough(),
    events = new EventEmitter();
  let buffer = "";
  const rows: RpcRow[] = [];
  const waitUntil = <T>(read: () => T | undefined) => receiveEvent(read, events);
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const split = buffer.indexOf("\n");
      if (split < 0) break;
      rows.push(JSON.parse(buffer.slice(0, split)));
      buffer = buffer.slice(split + 1);
      events.emit("row");
    }
  });
  const running = runEditorFollowAcp(project, queue, { input, output });
  const send = (id: number | undefined, method: string, params: object) =>
    input.write(
      JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) +
        "\n",
    );
  send(1, "initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  await waitUntil(() => rows.find((r) => r.id === 1));
  send(2, "session/new", { cwd: project });
  const session = (await waitUntil(() => rows.find((r) => r.id === 2))).result!.sessionId!;
  send(3, "session/prompt", {
    sessionId: session,
    prompt: [{ type: "text", text: "Follow only" }],
  });
  await waitUntil(() => rows.find((r) => r.method === "session/update"));
  const request = async (id: string, extra: object = {}) => {
    const temporary = Path.join(queue, id + ".tmp");
    await Fs.writeFile(
      temporary,
      JSON.stringify({ id, op: "follow", sessionId: session, path: "a.ts", line: 4, ...extra }),
      { flag: "wx" },
    );
    await Fs.link(temporary, Path.join(queue, id + ".request.json"));
    await Fs.unlink(temporary);
  };
  const receipt = (id: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const name = id + ".receipt.json";
      const finish = (error: unknown, value?: Record<string, unknown>) => {
        clearTimeout(timer);
        watcher.close();
        error ? reject(error) : resolve(value!);
      };
      const read = async () => {
        try {
          finish(null, JSON.parse(await Fs.readFile(Path.join(queue, name), "utf8")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") finish(error);
        }
      };
      const watcher = watch(queue, (_event, file) => {
        if (file === name) void read();
      });
      const timer = setTimeout(() => finish(new Error("Receipt event deadline exceeded")), 1500);
      void read();
    });
  return {
    root,
    project,
    queue,
    input,
    rows,
    send,
    session,
    request,
    receipt,
    waitUntil,
    close: async () => {
      input.end();
      await running;
    },
  };
}
it("follows exact zero-based ACP lines without file contents or client filesystem capabilities", async () => {
  const f = await fixture();
  try {
    await f.request("follow-one");
    expect(await f.receipt("follow-one")).toMatchObject({
      ok: true,
      notificationOnly: true,
      fileRead: false,
      fileWrite: false,
    });
    const call = f.rows.find((r) => r.params?.update?.sessionUpdate === "tool_call")!;
    expect(call.params!.update!.locations).toEqual([
      { path: Path.join(f.project, "a.ts"), line: 3 },
    ]);
    expect(f.rows.some((r) => String(r.method).startsWith("fs/"))).toBe(false);
    expect(await Fs.readFile(Path.join(f.project, "a.ts"), "utf8")).toBe(
      "first\nsecond\nthird\nfourth\n",
    );
  } finally {
    await f.close();
  }
});
it.each([
  { path: "../outside.ts" },
  { path: ".private.ts" },
  { sessionId: "other-session" },
  { line: 0 },
  { op: "edit", content: "replace" },
])("refuses unsafe or mismatched follow request %j", async (extra) => {
  const f = await fixture();
  try {
    await f.request("refused", extra);
    expect(await f.receipt("refused")).toMatchObject({ ok: false, noReplay: true });
    expect(f.rows.some((r) => r.params?.update?.sessionUpdate === "tool_call")).toBe(false);
    expect(await Fs.readFile(Path.join(f.project, "a.ts"), "utf8")).toBe(
      "first\nsecond\nthird\nfourth\n",
    );
  } finally {
    await f.close();
  }
});
it("does not replay a prior claim with unknown delivery", async () => {
  const f = await fixture();
  try {
    await Fs.writeFile(Path.join(f.queue, "claimed.claimed.json"), "{}");
    await f.request("claimed");
    expect(await f.receipt("claimed")).toMatchObject({ ok: false, noReplay: true });
    expect(f.rows.some((r) => r.params?.update?.sessionUpdate === "tool_call")).toBe(false);
  } finally {
    await f.close();
  }
});
it("cancel stops following and a new editor session can start in the same bridge", async () => {
  const f = await fixture();
  try {
    f.send(undefined, "session/cancel", { sessionId: f.session });
    expect((await f.waitUntil(() => f.rows.find((r) => r.id === 3))).result!.stopReason).toBe(
      "cancelled",
    );
    f.send(4, "session/new", { cwd: f.project });
    const next = (await f.waitUntil(() => f.rows.find((r) => r.id === 4))).result!.sessionId!;
    f.send(5, "session/prompt", { sessionId: next, prompt: [] });
    await f.waitUntil(() => f.rows.find((r) => r.params?.sessionId === next));
    await f.request("next", { sessionId: next });
    expect(await f.receipt("next")).toMatchObject({ ok: true });
  } finally {
    await f.close();
  }
});
