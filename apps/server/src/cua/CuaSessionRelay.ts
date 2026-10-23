/** Configure the authenticated MCP transport's implicit session before actions. */
export const createCuaSessionRelay = (io: {
  readonly bootstrapId: string;
  readonly send: (message: unknown) => void;
  readonly receive: (message: unknown) => void;
  readonly fail: (error: Error) => void;
  readonly ready: () => void;
}) => {
  let state: "new" | "waiting" | "ready" | "failed" = "new";
  let pending: Array<Record<string, unknown>> = [];
  const fail = (message: string) => {
    state = "failed";
    for (const request of pending)
      io.receive({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } });
    pending = [];
    io.fail(new Error(message));
  };
  return {
    agent(message: Record<string, unknown>) {
      if (message.id === io.bootstrapId) return fail("Reserved Cua bootstrap request ID");
      if (state === "failed") return;
      if (message.method === "tools/call" && state !== "ready") {
        pending.push(message);
        if (state === "new") {
          state = "waiting";
          io.send({
            jsonrpc: "2.0",
            id: io.bootstrapId,
            method: "tools/call",
            params: {
              name: "start_session",
              arguments: { cursor_motion: { timing: "fixed", glide_duration_ms: 1 } },
            },
          });
        }
        return;
      }
      if (state === "waiting" && message.method === "notifications/cancelled") {
        const id = (message.params as { requestId?: unknown } | undefined)?.requestId;
        const index = pending.findIndex((request) => request.id === id);
        if (index !== -1) {
          pending.splice(index, 1);
          io.receive({
            jsonrpc: "2.0",
            id,
            error: { code: -32800, message: "Request cancelled before Cua dispatch" },
          });
          return;
        }
      }
      io.send(message);
    },
    driver(message: Record<string, unknown>) {
      if (message.id !== io.bootstrapId) {
        io.receive(message);
        return;
      }
      if (state !== "waiting") return fail("Unexpected Cua bootstrap response");
      const result = message.result as
        | {
            isError?: boolean;
            structuredContent?: { cursor_motion?: { timing?: string; glide_duration_ms?: number } };
            content?: Array<{ type: string; text?: string }>;
          }
        | undefined;
      let output = result?.structuredContent;
      if (!output) {
        try {
          output = JSON.parse(
            result?.content?.find((item) => item.type === "text")?.text ?? "null",
          );
        } catch {
          /* rejected below */
        }
      }
      if (
        message.error ||
        result?.isError ||
        output?.cursor_motion?.timing !== "fixed" ||
        output.cursor_motion.glide_duration_ms !== 1
      )
        return fail("Cua did not confirm the requested cursor motion");
      state = "ready";
      io.ready();
      const queued = pending;
      pending = [];
      for (const request of queued) io.send(request);
    },
    abort() {
      fail("Cua session initialization did not complete");
    },
  };
};
