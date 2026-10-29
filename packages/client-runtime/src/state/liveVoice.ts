import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createLiveVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:live-voice:events",
      tag: WS_METHODS.liveVoiceSubscribe,
      // Stream atoms retain only the last value per chunk, including reconnect replays.
      transform: (stream) => stream.pipe(Stream.rechunk(1)),
      idleTtlMs: 0,
    }),
    prepare: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:live-voice:prepare",
      tag: WS_METHODS.liveVoicePrepare,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:live-voice:start",
      tag: WS_METHODS.liveVoiceStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:live-voice:stop",
      tag: WS_METHODS.liveVoiceStop,
    }),
    status: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:live-voice:status",
      tag: WS_METHODS.liveVoiceStatus,
    }),
  };
}
