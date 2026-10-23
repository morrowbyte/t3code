import type { ThreadId } from "@t3tools/contracts";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  requestEnvironmentLiveVoiceHistory,
  requestEnvironmentLiveVoiceTranscript,
} from "@t3tools/client-runtime/state/live-voice-history";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import { connectionAtomRuntime } from "../../connection/runtime";

class VoiceHistoryDisconnected extends Schema.TaggedError<VoiceHistoryDisconnected>()(
  "VoiceHistoryDisconnected",
  {},
) {}

const authorization = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) return yield* new VoiceHistoryDisconnected({});
  return {
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
  };
});

const callsQuery = (refreshIntervalMs?: number) =>
  createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: refreshIntervalMs ? "live-voice-history:recent" : "live-voice-history:earlier",
    idleTtlMs: 0,
    ...(refreshIntervalMs ? { refreshIntervalMs } : {}),
    execute: Effect.fn("NativeVoiceCallHistory.calls")(function* (input: {
      threadId: ThreadId;
      before?: string;
    }) {
      return yield* requestEnvironmentLiveVoiceHistory({ ...input, ...(yield* authorization) });
    }),
  });

export const voiceCallHistoryQuery = callsQuery(3_000);
export const earlierVoiceCallHistoryQuery = callsQuery();
export const voiceCallTranscriptQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "live-voice-history:transcript",
  idleTtlMs: 0,
  execute: Effect.fn("NativeVoiceCallHistory.transcript")(function* (input: {
    threadId: ThreadId;
    leaseId: string;
    generation: number;
    lastEventId: number;
  }) {
    return yield* requestEnvironmentLiveVoiceTranscript({ ...input, ...(yield* authorization) });
  }),
});
