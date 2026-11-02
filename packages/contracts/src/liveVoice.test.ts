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
import { LiveVoiceContextDeliveredInput, LiveVoiceContextInput } from "./liveVoiceContext.ts";

const decodeLiveVoiceStartInput = Schema.decodeSync(LiveVoiceStartInput);
const decodeLiveVoiceGeneration = Schema.decodeSync(LiveVoiceGeneration);
const decodeLiveVoiceSession = Schema.decodeSync(LiveVoiceSession);
const decodeLiveVoicePrepareInput = Schema.decodeSync(LiveVoicePrepareInput);
const decodeUnknownLiveVoicePrepareInput = Schema.decodeUnknownSync(LiveVoicePrepareInput);
const decodeLiveVoiceSubscribeInput = Schema.decodeSync(LiveVoiceSubscribeInput);

describe("subscription Codex Live contracts", () => {
  it("registers selected context as a unary RPC with a void response", () => {
    for (const [method, input] of [
      [
        WS_METHODS.liveVoiceContext,
        { leaseId: "lease", generation: 1, revision: 1, context: null },
      ],
      [
        WS_METHODS.liveVoiceContextDelivered,
        { leaseId: "lease", generation: 1, deliveryId: "context-1", accepted: true },
      ],
    ] as const) {
      const rpc = WsRpcGroup.requests.get(method);
      if (!rpc) throw new Error(`${method} is not registered`);
      const decodeInput = Schema.decodeUnknownSync(rpc.payloadSchema);
      const decodeResponse = Schema.decodeUnknownSync(rpc.successSchema);
      expect(decodeInput(input)).toEqual(input);
      expect(decodeResponse(undefined)).toBeUndefined();
    }
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
    const delivered = { leaseId: "lease", generation: 1, deliveryId: "context-1", accepted: true };
    const decodeDelivered = Schema.decodeUnknownSync(LiveVoiceContextDeliveredInput);
    expect(decodeDelivered(delivered)).toEqual(delivered);
    expect(decodeDelivered({ ...delivered, accepted: false }).accepted).toBe(false);
    expect(decodeDelivered({ ...delivered, deliveryId: "x".repeat(256) }).deliveryId).toHaveLength(
      256,
    );
    for (const invalid of [
      { deliveryId: "" },
      { deliveryId: "x".repeat(257) },
      { accepted: "true" },
      { generation: 0 },
      { generation: Number.MAX_SAFE_INTEGER + 1 },
      { leaseId: "" },
    ])
      expect(() => decodeDelivered({ ...delivered, ...invalid })).toThrow();
    const contextEvent = {
      type: "context",
      leaseId: "lease",
      generation: 1,
      deliveryId: "context-1",
      text: "  Original context\n",
    };
    const decodeEvent = Schema.decodeUnknownSync(LiveVoiceEvent);
    expect(decodeEvent(contextEvent)).toEqual(contextEvent);
    expect(decodeEvent({ ...contextEvent, text: "x".repeat(24_000) }).type).toBe("context");
    for (const invalid of [
      { deliveryId: "" },
      { deliveryId: "x".repeat(257) },
      { text: "x".repeat(24_001) },
      { generation: 0 },
    ])
      expect(() => decodeEvent({ ...contextEvent, ...invalid })).toThrow();
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
    const activity = {
      type: "activity",
      leaseId: "lease",
      generation: 1,
      environmentId: "env",
      threadId: "thread",
      activity: {
        id: "native-call",
        revision: 2,
        action: "read-work",
        status: "running",
        occurredAt: "received",
        updatedAt: "received",
      },
    };
    expect(
      decode({
        ...activity,
        activity: { ...activity.activity, input: "private", output: "private" },
      }),
    ).toEqual(activity);
    expect(() =>
      decode({
        ...activity,
        activity: { ...activity.activity, action: "private payload as label" },
      }),
    ).toThrow();
    expect(() =>
      decode({ ...activity, activity: { ...activity.activity, revision: 0 } }),
    ).toThrow();
  });

  it("bounds offer size and requires a positive lease generation", () => {
    expect(
      decodeLiveVoiceStartInput({
        leaseId: "lease-1",
        generation: 1,
        offerSdp: "v=0",
        clientRequestId: "request-1",
      }).generation,
    ).toBe(1);
    expect(() =>
      decodeLiveVoiceStartInput({
        leaseId: "lease-1",
        generation: 0,
        offerSdp: "v=0",
        clientRequestId: "request-1",
      }),
    ).toThrow();
    expect(() => decodeLiveVoiceGeneration(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("represents preparation and recovery without fabricated provider identities", () => {
    expect(
      decodeLiveVoiceSession({
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
    const input = decodeLiveVoicePrepareInput({
      threadId: "thread-1",
      clientRequestId: "request-1",
    });
    expect(input.threadId).toBe("thread-1");
    expect(
      decodeUnknownLiveVoicePrepareInput({
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
    expect(decodeLiveVoiceSubscribeInput({ leaseId: "lease-1", generation: 1 }).generation).toBe(1);
    expect(
      decodeLiveVoiceSubscribeInput({ leaseId: "lease-1", generation: 1, includeActivities: true })
        .includeActivities,
    ).toBe(true);
  });
});
