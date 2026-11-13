// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { parseReplayTurns, SCENARIOS, streamChunks } from "./dev-replay-agent.ts";

interface AgentMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: {
    readonly update?: {
      readonly sessionUpdate?: string;
      readonly toolCallId?: string;
      readonly status?: string;
      readonly content?: { readonly type?: string; readonly text?: string };
    };
  };
  readonly result?: { readonly sessionId?: string; readonly stopReason?: string };
  readonly error?: { readonly code?: number };
}

/**
 * Runs the agent over stdio and returns every message it sent until each request is answered.
 * Permission requests get `permissionResult`.
 */
const agentPath = NodeURL.fileURLToPath(new URL("./dev-replay-agent.ts", import.meta.url));

interface ControlStatus {
  readonly sessionId: string;
  readonly state: string;
  readonly frame: number;
  readonly chunk: number;
  readonly emittedChunks: number;
  readonly socket: string;
}
const control = async (action: string, sessionId: string): Promise<ControlStatus> => {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      process.execPath,
      [agentPath, "--control", action, "--session", sessionId],
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
    child.stdin?.end();
  });
  return JSON.parse(stdout) as ControlStatus;
};

async function talkToAgent(
  requests: ReadonlyArray<(sessionId: string) => object>,
  permissionResult: object = { outcome: { outcome: "selected", optionId: "allow-once" } },
  formResult: object | ((index: number) => object | "cancel-turn") = { action: "cancel" },
  observe?: (
    message: AgentMessage,
    context: {
      sessionId: string;
      received: ReadonlyArray<AgentMessage>;
      send: (message: object) => void;
    },
  ) => Promise<void>,
) {
  const agent = NodeChildProcess.spawn(process.execPath, [agentPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = NodeReadline.createInterface({ input: agent.stdout })[Symbol.asyncIterator]();
  const received: Array<AgentMessage> = [];
  let sessionId = "";
  let pendingForm: AgentMessage | undefined;
  let formCount = 0;
  try {
    for (const [index, request] of requests.entries()) {
      agent.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request(sessionId) })}\n`,
      );
      for (;;) {
        const message = JSON.parse((await lines.next()).value as string) as AgentMessage;
        received.push(message);
        await observe?.(message, {
          sessionId: message.result?.sessionId ?? sessionId,
          received,
          send: (message) =>
            agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
        });
        if (message.method === "elicitation/create") {
          pendingForm = message;
          agent.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 10000, method: "initialize" })}\n`,
          );
          continue;
        }
        if (message.id === 10000) {
          expect(received.at(-2)).toBe(pendingForm);
          const result = typeof formResult === "function" ? formResult(formCount++) : formResult;
          agent.stdin.write(
            `${JSON.stringify(
              result === "cancel-turn"
                ? { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }
                : { jsonrpc: "2.0", id: pendingForm!.id, result },
            )}\n`,
          );
          pendingForm = undefined;
          continue;
        }
        if (message.method === "session/request_permission") {
          const answer = { jsonrpc: "2.0", id: message.id, result: permissionResult };
          agent.stdin.write(`${JSON.stringify(answer)}\n`);
        }
        if (message.id !== index + 1 || message.method !== undefined) continue;
        sessionId = message.result?.sessionId ?? sessionId;
        break;
      }
    }
  } finally {
    const exited = new Promise<void>((resolve) => agent.once("exit", () => resolve()));
    agent.stdin.end();
    await exited;
  }
  return { sessionId, received };
}

const newSession = () => ({ method: "session/new", params: { cwd: "/tmp" } });
const selectScenario = (modelId: string) => (sessionId: string) => ({
  method: "session/set_model",
  params: { sessionId, modelId },
});
const prompt = (sessionId: string) => ({ method: "session/prompt", params: { sessionId } });
const replyText = (received: ReadonlyArray<AgentMessage>) =>
  received
    .map((message) =>
      message.params?.update?.sessionUpdate === "agent_message_chunk"
        ? (message.params.update.content?.text ?? "")
        : "",
    )
    .join("");
const lunch = {
  name: "Ada",
  guests: 3,
  time: "13:00",
  food: ["Vegan", "Gluten-free"],
  reminder: false,
  notes: "By the window, $&",
};

describe("dev replay agent", () => {
  it("pauses at the current chunk, resumes losslessly and finishes without remaining paused state", async () => {
    let paused: ControlStatus | undefined;
    let resumes = 0;
    let otherSessionId = "";
    let socketPath = "";
    const { received } = await talkToAgent(
      [newSession, newSession, selectScenario("recorded-answers"), prompt],
      undefined,
      undefined,
      async (message, { sessionId, received, send }) => {
        if (message.id === 1) otherSessionId = sessionId;
        if (
          message.params?.update?.sessionUpdate === "agent_message_chunk" &&
          paused === undefined &&
          resumes < 2
        ) {
          paused = await control("pause", sessionId);
          expect(paused.state).toBe("paused");
          expect(paused.chunk).toBeGreaterThan(0);
          socketPath = paused.socket;
          const directory = NodePath.dirname(socketPath);
          expect(NodeFS.statSync(directory).mode & 0o777).toBe(0o700);
          expect(NodeFS.statSync(NodePath.join(directory, "owner.json")).mode & 0o777).toBe(0o600);
          expect((await control("status", otherSessionId)).state).toBe("idle");
          await expect(control("pause", otherSessionId)).rejects.toThrow(
            "No replay turn is running",
          );
          await expect(control("pause", "unknown-session")).rejects.toThrow("found 0");
          expect(await control("pause", sessionId)).toEqual(paused);
          send({ id: 10001, method: "initialize" });
        }
        if (message.id === 10001) {
          expect(await control("status", sessionId)).toEqual(paused);
          expect(
            received.filter(
              (entry) => entry.params?.update?.sessionUpdate === "agent_message_chunk",
            ),
          ).toHaveLength(paused!.emittedChunks);
          expect((await control("resume", sessionId)).state).toBe("playing");
          expect((await control("resume", sessionId)).state).toBe("playing");
          resumes += 1;
          paused = undefined;
        }
        if (message.id === 4 && message.method === undefined) {
          expect((await control("status", sessionId)).state).toBe("idle");
          await expect(control("pause", sessionId)).rejects.toThrow("No replay turn is running");
        }
      },
    );
    const transcript = NodeFS.readFileSync(
      new URL("./dev-replay/answers_transcript.ndjson", import.meta.url),
      "utf8",
    );
    const expected = parseReplayTurns(transcript)[0]!
      .frames.flatMap(({ frame }) => {
        const params = frame.params as AgentMessage["params"];
        return params?.update?.sessionUpdate === "agent_message_chunk"
          ? [params.update.content?.text ?? ""]
          : [];
      })
      .join("");
    expect(replyText(received)).toBe(expected);
    expect(resumes).toBe(2);
    expect(NodeFS.existsSync(NodePath.dirname(socketPath))).toBe(false);
    expect(received.at(-1)?.result?.stopReason).toBe("end_turn");
  });

  it("cancels a freely paused turn and wakes it without requiring resume", async () => {
    let cancelled = false;
    const { received } = await talkToAgent(
      [newSession, selectScenario("recorded-answers"), prompt],
      undefined,
      undefined,
      async (message, { sessionId, send }) => {
        if (message.params?.update?.sessionUpdate === "agent_message_chunk" && !cancelled) {
          cancelled = true;
          expect((await control("pause", sessionId)).state).toBe("paused");
          send({ method: "session/cancel", params: { sessionId } });
        }
        if (message.id === 3 && message.method === undefined) {
          expect((await control("status", sessionId)).state).toBe("idle");
        }
      },
    );
    expect(received.at(-1)?.result?.stopReason).toBe("cancelled");
    expect(replyText(received)).toContain("Replay cancelled.");
  });

  it("preserves an answered elicitation while freely paused and continues once on resume", async () => {
    let paused: ControlStatus | undefined;
    const { received } = await talkToAgent(
      [newSession, selectScenario("form"), prompt],
      undefined,
      { action: "accept", content: lunch },
      async (message, { sessionId, send }) => {
        if (message.method === "elicitation/create") {
          paused = await control("pause", sessionId);
          expect(paused.state).toBe("paused");
        }
        if (message.id === 10000) send({ id: 10001, method: "initialize" });
        if (message.id === 10001) {
          expect(await control("status", sessionId)).toEqual(paused);
          await control("resume", sessionId);
        }
      },
    );
    expect(replyText(received).match(/Lunch planned:/g)).toHaveLength(1);
    expect(replyText(received)).toContain('"reminder": false');
    expect(received.at(-1)?.result?.stopReason).toBe("end_turn");
  });

  it("evaluates typed form content only after the ACP checkpoint returns", async () => {
    const { received } = await talkToAgent(
      [newSession, selectScenario("form"), prompt],
      undefined,
      { action: "accept", content: lunch },
    );
    const text = replyText(received);
    for (const value of [
      "Ada",
      "3",
      "13:00",
      "Vegan",
      "Gluten-free",
      "false",
      "By the window, $&",
    ]) {
      expect(text).toContain(value);
    }
    expect(text).toContain("Lunch planned:");
    expect(received.some((message) => message.id === 10000)).toBe(true);
  });

  it.each([
    { action: "accept" },
    { action: "accept", content: { ...lunch, name: undefined } },
    { action: "accept", content: { ...lunch, reminder: undefined } },
    { action: "accept", content: { ...lunch, name: "A" } },
    { action: "accept", content: { ...lunch, reminder: "false" } },
    { action: "accept", content: { ...lunch, guests: 0 } },
    { action: "accept", content: { ...lunch, time: "14:00" } },
    { action: "accept", content: { ...lunch, food: ["Vegan", "Fish"] } },
    { action: "accept", content: { ...lunch, food: ["Vegan", "Vegan", "Vegan"] } },
  ])("rejects missing or invalid form content: %j", async (answer) => {
    const { received } = await talkToAgent(
      [newSession, selectScenario("form"), prompt],
      undefined,
      answer,
    );
    expect(replyText(received)).toContain("Form response invalid:");
    expect(replyText(received)).not.toContain("Lunch planned:");
    expect(replyText(received)).not.toContain("received");
  });

  it.each(["cancel", "decline"])("shows a %s form outcome without success", async (action) => {
    const { received } = await talkToAgent(
      [newSession, selectScenario("form"), prompt],
      undefined,
      { action },
    );
    expect(replyText(received)).toContain(
      action === "cancel" ? "Form cancelled." : "Form declined.",
    );
    expect(replyText(received)).not.toContain("Lunch planned:");
  });

  it("streams two visual turns with a stable correction and then ends the replay", async () => {
    const { received } = await talkToAgent(
      [newSession, selectScenario("visual"), prompt, prompt, prompt],
      undefined,
      { action: "accept", content: { continue: "Continue" } },
      async (message, { sessionId }) => {
        if (message.id === 5 && message.method === undefined) {
          expect((await control("status", sessionId)).state).toBe("complete");
          await expect(control("resume", sessionId)).rejects.toThrow("No replay turn is running");
        }
      },
    );
    const first = received.findIndex((message) => message.id === 3 && message.method === undefined);
    const second = received.findIndex(
      (message) => message.id === 4 && message.method === undefined,
    );
    const initial = replyText(received.slice(0, first));
    const correction = replyText(received.slice(first + 1, second));
    const records = (text: string) =>
      text
        .split("\n")
        .filter((line) => line.startsWith('{"type":'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(initial).toContain("$$");
    expect(initial).toContain("\\frac");
    expect(records(initial)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "chart",
          id: expect.stringMatching(/^result-.*-energy$/),
          yLabel: "kWh",
        }),
        expect.objectContaining({ type: "series", key: "actual", label: "Ist" }),
        expect.objectContaining({ type: "series", key: "target", label: "Ziel" }),
        expect.objectContaining({ type: "edge", from: "check", to: "adjust" }),
      ]),
    );
    expect(records(correction)).toContainEqual(
      expect.objectContaining({ type: "series", key: "actual" }),
    );
    expect(records(correction)).toContainEqual(
      expect.objectContaining({ type: "point", series: "actual", label: "Fr", value: 18 }),
    );
    const chart = (text: string) => records(text).find((record) => record.type === "chart");
    expect(chart(initial)?.id).toEqual(chart(correction)?.id);
    expect(chart(initial)?.id).toEqual(expect.any(String));
    expect(chart(initial)?.id).not.toContain("<result-id>");
    expect(replyText(received.slice(second + 1))).toContain("Replay complete.");
    expect(replyText(received.slice(second + 1))).not.toContain("```t3-ui");
  });

  it("retries a cancelled ACP checkpoint from the beginning without consuming the turn", async () => {
    const { received } = await talkToAgent(
      [newSession, selectScenario("form"), prompt, prompt, prompt],
      undefined,
      (index) => (index === 0 ? "cancel-turn" : { action: "accept", content: lunch }),
    );
    const cancelled = received.findIndex(
      (message) => message.id === 3 && message.method === undefined,
    );
    expect(received[cancelled]?.result?.stopReason).toBe("cancelled");
    expect(replyText(received.slice(0, cancelled))).toContain("Replay cancelled.");
    expect(replyText(received.slice(0, cancelled))).not.toContain("Lunch planned:");
    expect(replyText(received.slice(cancelled + 1))).toContain(
      "Replay restarts the interrupted turn",
    );
    expect(replyText(received.slice(cancelled + 1))).toContain("Lunch planned:");
    expect(replyText(received.slice(cancelled + 1))).toContain("Replay complete.");
  });

  it("retries invalid content and preserves typed false instead of advancing to completion", async () => {
    const { received } = await talkToAgent(
      [newSession, selectScenario("form"), prompt, prompt],
      undefined,
      (index) => ({ action: "accept", content: index === 0 ? {} : lunch }),
    );
    expect(replyText(received)).toContain("Form response invalid:");
    expect(replyText(received)).toContain('"reminder": false');
    expect(replyText(received)).toContain("Lunch planned:");
    expect(replyText(received)).not.toContain("Replay complete.");
  });

  it("keeps sessions and tool ids unique across processes and reloads", async () => {
    const prompt = (sessionId: string) => ({ method: "session/prompt", params: { sessionId } });
    const selectTodoList = (sessionId: string) => ({
      method: "session/set_model",
      params: { sessionId, modelId: "todo-list" },
    });
    const run = () =>
      talkToAgent([
        () => ({ method: "session/new", params: { cwd: "/tmp" } }),
        selectTodoList,
        prompt,
        prompt,
      ]);
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.sessionId).not.toBe(second.sessionId);
    // A server restart loads the same session in a new agent process.
    const reloaded = await talkToAgent([
      () => ({ method: "session/load", params: { sessionId: first.sessionId, cwd: "/tmp" } }),
      () => selectTodoList(first.sessionId),
      () => prompt(first.sessionId),
    ]);
    const toolCallIds = [...first.received, ...reloaded.received].flatMap((message) =>
      message.params?.update?.toolCallId === undefined ? [] : [message.params.update.toolCallId],
    );
    expect(new Set(toolCallIds).size).toBe(4);
    expect(replyText(first.received)).toContain("Replay complete.");
    expect(replyText(reloaded.received)).toContain("Replay restarted after reload");
  });

  it.each(SCENARIOS)("$id plays a turn without session setup frames", ({ file }) => {
    const turns = parseReplayTurns(NodeFS.readFileSync(new URL(file, import.meta.url), "utf8"));
    expect(turns.length).toBeGreaterThan(0);
    const updates = turns.flatMap((turn) =>
      turn.frames.flatMap(({ frame }) =>
        frame.method === "session/update"
          ? [(frame.params as { update: { sessionUpdate: string } }).update.sessionUpdate]
          : [],
      ),
    );
    expect(updates).toContain("agent_message_chunk");
    expect(updates).not.toContain("available_commands_update");
  });

  it("keeps permission requests and the recorded stop reason in order", () => {
    const turns = parseReplayTurns(
      NodeFS.readFileSync(new URL(SCENARIOS[0].file, import.meta.url), "utf8"),
    );
    const methods = turns[0]!.frames.map(({ frame }) => frame.method);
    expect(methods).toContain("session/request_permission");
    expect(turns[0]!.stopReason).toBe("end_turn");
  });

  it("rejects an unknown scenario instead of playing another one", async () => {
    const { received } = await talkToAgent([
      () => ({ method: "session/new", params: { cwd: "/tmp" } }),
      (sessionId) => ({ method: "session/set_model", params: { sessionId, modelId: "typo" } }),
    ]);
    expect(received.at(-1)?.error?.code).toBe(-32602);
  });

  it("ends the turn with a failed tool call when the user rejects an approval", async () => {
    const { received } = await talkToAgent(
      [
        () => ({ method: "session/new", params: { cwd: "/tmp" } }),
        (sessionId) => ({ method: "session/prompt", params: { sessionId } }),
      ],
      { outcome: { outcome: "selected", optionId: "reject-once" } },
    );
    const updates = received.flatMap((message) =>
      message.params?.update === undefined ? [] : [message.params.update],
    );
    expect(updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
    expect(updates.some((update) => update.toolCallId?.endsWith("showcase-test"))).toBe(false);
    expect(received.at(-1)?.result?.stopReason).toBe("end_turn");
  });

  it("ends the turn as cancelled when the client cancels an open approval", async () => {
    const { received } = await talkToAgent(
      [
        () => ({ method: "session/new", params: { cwd: "/tmp" } }),
        (sessionId) => ({ method: "session/prompt", params: { sessionId } }),
      ],
      { outcome: { outcome: "cancelled" } },
      undefined,
      async (message, { sessionId }) => {
        if (message.method === "session/request_permission") {
          expect((await control("pause", sessionId)).state).toBe("paused");
        }
      },
    );
    const requestIndex = received.findIndex(
      (message) => message.method === "session/request_permission",
    );
    expect(replyText(received.slice(requestIndex + 1))).toContain("Replay cancelled.");
    expect(
      received
        .slice(requestIndex + 1)
        .some((message) => message.params?.update?.toolCallId !== undefined),
    ).toBe(false);
    expect(received.at(-1)?.result?.stopReason).toBe("cancelled");
  });

  it("leaves frames after a prompt's response out of that turn", () => {
    const update = (text: string) => ({
      type: "emit_inbound",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      },
    });
    const transcript = [
      { type: "expect_outbound", frame: { kind: "request", method: "session/prompt" } },
      update("root"),
      { type: "emit_inbound", frame: { kind: "response", method: "session/prompt", result: {} } },
      update("background"),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const turns = parseReplayTurns(transcript);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.frames).toHaveLength(1);
  });

  it("streams text in chunks that rebuild the original", () => {
    const text = "One two three four five\n\n```ts\nx\n```";
    const chunks = streamChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });
});
