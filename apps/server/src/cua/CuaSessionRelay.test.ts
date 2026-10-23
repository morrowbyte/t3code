import { expect, it } from "vite-plus/test";
import { createCuaSessionRelay } from "./CuaSessionRelay.ts";

const setup = () => {
  const sent: unknown[] = [],
    received: unknown[] = [],
    failures: Error[] = [];
  let ready = 0;
  const relay = createCuaSessionRelay({
    bootstrapId: "private-bootstrap",
    send: (x) => sent.push(x),
    receive: (x) => received.push(x),
    fail: (e) => failures.push(e),
    ready: () => ready++,
  });
  const confirm = () =>
    relay.driver({
      jsonrpc: "2.0",
      id: "private-bootstrap",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ cursor_motion: { timing: "fixed", glide_duration_ms: 1 } }),
          },
        ],
      },
    });
  return { relay, sent, received, failures, confirm, ready: () => ready };
};
const action = {
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "click", arguments: { text: "Save" } },
};

it("preserves initialize, configures the same transport once, then preserves actions and image results", () => {
  const h = setup();
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "fixture" },
  };
  h.relay.agent(initialize);
  h.relay.agent({ jsonrpc: "2.0", method: "notifications/initialized" });
  h.relay.agent(action);
  h.relay.agent({ ...action, id: 8 });
  expect(h.sent).toHaveLength(3);
  expect(h.sent[0]).toEqual(initialize);
  expect(h.sent[2]).toMatchObject({
    id: "private-bootstrap",
    method: "tools/call",
    params: {
      name: "start_session",
      arguments: { cursor_motion: { timing: "fixed", glide_duration_ms: 1 } },
    },
  });
  h.confirm();
  expect(h.ready()).toBe(1);
  expect(h.sent.slice(3)).toEqual([action, { ...action, id: 8 }]);
  expect(h.received).toEqual([]);
  const result = {
    jsonrpc: "2.0",
    id: 7,
    result: {
      isError: false,
      content: [{ type: "image", data: "exact-base64", mimeType: "image/png" }],
      _meta: { fixture: true },
    },
  };
  h.relay.driver(result);
  expect(h.received).toEqual([result]);
  h.relay.agent({ ...action, id: 9 });
  expect(h.sent).toHaveLength(6);
});

it("rejects error, missing and incorrect motion echoes without dispatching a task", () => {
  for (const result of [
    { isError: true },
    {},
    { structuredContent: { cursor_motion: { timing: "steady", glide_duration_ms: 1 } } },
  ]) {
    const h = setup();
    h.relay.agent(action);
    h.relay.driver({ jsonrpc: "2.0", id: "private-bootstrap", result });
    expect(h.sent).toHaveLength(1);
    expect(h.failures).toHaveLength(1);
    expect(h.received).toEqual([
      expect.objectContaining({ id: 7, error: expect.objectContaining({ code: -32000 }) }),
    ]);
    h.relay.agent({ ...action, id: 8 });
    expect(h.sent).toHaveLength(1);
  }
});

it("cancels a queued non-idempotent request without ever sending it to Cua", () => {
  const h = setup();
  h.relay.agent(action);
  h.relay.agent({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
  h.confirm();
  expect(h.sent).toHaveLength(1);
  expect(h.received).toEqual([
    expect.objectContaining({ id: 7, error: { code: -32800, message: expect.any(String) } }),
  ]);
});

it("fails closed on bootstrap timeout and reserved ID collisions", () => {
  const h = setup();
  h.relay.agent(action);
  h.relay.abort();
  expect(h.failures).toHaveLength(1);
  expect(h.sent).toHaveLength(1);
  const collision = setup();
  collision.relay.agent({ ...action, id: "private-bootstrap" });
  expect(collision.failures).toHaveLength(1);
  expect(collision.sent).toEqual([]);
});
