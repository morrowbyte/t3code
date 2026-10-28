import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  LiveVoiceGeneration,
  LiveVoiceSession,
  LiveVoicePrepareInput,
  LiveVoiceStartInput,
  LiveVoiceSubscribeInput,
  LiveVoiceEvent,
} from "./liveVoice.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthOrchestrationOperateScope } from "./auth.ts";
import { LiveVoiceContextInput } from "./liveVoiceContext.ts";

describe("subscription Codex Live contracts", () => {
  it("registers selected context as a unary RPC with a void response", () => {
    const rpc = WsRpcGroup.requests.get(WS_METHODS.liveVoiceContext);
    if (!rpc) throw new Error("liveVoice.context is not registered");
    const input = { leaseId: "lease", generation: 1, revision: 1, context: null };
    const decodeInput = Schema.decodeUnknownSync(rpc.payloadSchema);
    const decodeResponse = Schema.decodeUnknownSync(rpc.successSchema);
    expect(decodeInput(input)).toEqual(input);
    expect(decodeResponse(undefined)).toBeUndefined();
  });

  it("bounds selected context and requires positive safe lease revisions, including clear", () => {
    const decode = Schema.decodeUnknownSync(LiveVoiceContextInput);
    const input = { leaseId: "lease", generation: 1, revision: 1, context: null };
    expect(decode(input)).toEqual(input);
    expect(decode({ ...input, context: "x".repeat(24_000) }).context).toHaveLength(24_000);
    for (const invalid of [
      { context: "x".repeat(24_001) },
      { revision: 0 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { generation: 0 },
      { leaseId: "" },
    ])
      expect(() => decode({ ...input, ...invalid })).toThrow();
  });

  it("preserves original transcript parts and validates revision correlation without changing legacy events", () => {
    const decode = Schema.decodeUnknownSync(LiveVoiceEvent);
    const legacy = {
      type: "transcript",
      leaseId: "lease",
      generation: 1,
      role: "user",
      text: "  Original ASR  ",
    };
    expect(decode(legacy)).toEqual(legacy);
    const segment = {
      id: "native-item",
      revision: 2,
      kind: "delta",
      final: false,
      partIndex: 0,
      partCount: 1,
    };
    expect(decode({ ...legacy, segment })).toEqual({ ...legacy, segment });
    for (const invalid of [
      { ...segment, partIndex: 1 },
      { ...segment, partCount: 257 },
      { ...segment, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...segment, final: true },
    ])
      expect(() => decode({ ...legacy, segment: invalid })).toThrow();
  });

  it("bounds offer size and requires a positive lease generation", () => {
    expect(
      Schema.decodeUnknownSync(LiveVoiceStartInput)({
        leaseId: "lease-1",
        generation: 1,
        offerSdp: "v=0",
        clientRequestId: "request-1",
      }).generation,
    ).toBe(1);
    expect(() =>
      Schema.decodeUnknownSync(LiveVoiceStartInput)({
        leaseId: "lease-1",
        generation: 0,
        offerSdp: "v=0",
        clientRequestId: "request-1",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(LiveVoiceGeneration)(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow();
  });

  it("represents preparation and recovery without fabricated provider identities", () => {
    expect(
      Schema.decodeUnknownSync(LiveVoiceSession)({
        leaseId: "lease-1",
        generation: 1,
        environmentId: "env-1",
        threadId: "thread-1",
        providerInstanceId: "codex-default",
        providerSessionId: null,
        plannerNativeThreadId: null,
        status: "preparing",
      }).plannerNativeThreadId,
    ).toBeNull();
  });

  it("keeps client signaling free of provider credentials and arbitrary targets", () => {
    const input = Schema.decodeUnknownSync(LiveVoicePrepareInput)({
      threadId: "thread-1",
      clientRequestId: "request-1",
    });
    expect(input.threadId).toBe("thread-1");
    expect(
      Schema.decodeUnknownSync(LiveVoicePrepareInput)({
        threadId: "thread-1",
        clientRequestId: "request-1",
        provider: "claude",
        token: "secret",
      }),
    ).toEqual(input);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoicePrepare, input)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoiceStart, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoiceStop, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoiceStatus, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoiceSubscribe, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(
      Schema.decodeUnknownSync(LiveVoiceSubscribeInput)({ leaseId: "lease-1", generation: 1 })
        .generation,
    ).toBe(1);
  });
});
