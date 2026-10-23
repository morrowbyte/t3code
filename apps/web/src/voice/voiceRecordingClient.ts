import {
  VoiceRecordingEntry,
  VoiceRecordingSettings,
  type EnvironmentId,
} from "@t3tools/contracts";
import { requestEnvironmentCallRecording } from "@t3tools/client-runtime/state/voice-recording";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

type Request = Parameters<typeof requestEnvironmentCallRecording>[1];
export const RECORDING_OPT_OUT_EVENT = "t3-call-recording-opt-out";
const decodeSettings = Schema.decodeUnknownSync(VoiceRecordingSettings);
const decodeEntries = Schema.decodeUnknownSync(Schema.Array(VoiceRecordingEntry));

/** Each call retains its selected environment/auth; a new login cannot adopt the old recording. */
export async function createRecordingTransport(environmentId: EnvironmentId) {
  const authorization = connectionAtomRuntime.fn<void>()((_input, get) =>
    Effect.gen(function* () {
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (Option.isNone(prepared) || prepared.value.environmentId !== environmentId)
        throw new Error("Environment disconnected");
      return {
        prepared: prepared.value,
        signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
        remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
      };
    }).pipe(Effect.withTracerEnabled(false)),
  );
  appAtomRegistry.set(authorization, undefined);
  const captured = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, authorization, { suspendOnWaiting: true }),
  );
  return async (input: Request): Promise<unknown> => {
    const request = connectionAtomRuntime.fn<void>()(() =>
      requestEnvironmentCallRecording(captured, input).pipe(Effect.withTracerEnabled(false)),
    );
    appAtomRegistry.set(request, undefined);
    const result = await Effect.runPromise(
      Effect.result(AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true })),
    );
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  };
}
export async function recordingSettingsRequest(environmentId: EnvironmentId, enabled?: boolean) {
  const request = await createRecordingTransport(environmentId);
  const value = decodeSettings(
    await request(
      enabled === undefined ? { action: "settings" } : { action: "updateSettings", enabled },
    ),
  );
  if (enabled === false) {
    window.dispatchEvent(new CustomEvent(RECORDING_OPT_OUT_EVENT, { detail: environmentId }));
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(RECORDING_OPT_OUT_EVENT);
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is already scoped to this origin.
      channel.postMessage(environmentId);
      channel.close();
    }
  }
  return value;
}
export async function listCallRecordings(environmentId: EnvironmentId) {
  return decodeEntries(await (await createRecordingTransport(environmentId))({ action: "list" }));
}
export async function downloadCallRecording(
  environmentId: EnvironmentId,
  entry: typeof VoiceRecordingEntry.Type,
  role: "user" | "assistant",
) {
  const blob = await (
    await createRecordingTransport(environmentId)
  )({ action: "file", id: entry.id, role });
  if (!(blob instanceof Blob)) throw new Error("Recording unavailable");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${entry.id}-${role}.${entry.mimeType.startsWith("audio/ogg") ? "ogg" : "webm"}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
