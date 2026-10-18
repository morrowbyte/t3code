import type { EnvironmentId } from "@t3tools/contracts";
import { VoiceTranscriptionHttpError } from "@t3tools/contracts";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import {
  requestEnvironmentVoiceSettings,
  transcribeEnvironmentVoiceRecording,
  voiceTranscriptionFailureMessage,
} from "@t3tools/client-runtime/state/voice-transcription";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import { File } from "expo-file-system";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";

class VoiceEnvironmentUnavailable extends Data.TaggedError("VoiceEnvironmentUnavailable")<{}> {}
const isVoiceTranscriptionHttpError = Schema.is(VoiceTranscriptionHttpError);

type VoiceRequest = {
  readonly environmentId: EnvironmentId;
  readonly signal: AbortSignal;
  readonly uri?: string;
};
const request = connectionAtomRuntime.fn<VoiceRequest>()(
  (input, get) =>
    Effect.gen(function* () {
      const prepared = get(environmentSession.preparedConnectionValueAtom(input.environmentId));
      if (Option.isNone(prepared) || prepared.value.environmentId !== input.environmentId) {
        return yield* new VoiceEnvironmentUnavailable();
      }
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      const authorization = { prepared: prepared.value, signer, remoteAuthorization };
      if (!input.uri) {
        const settings = yield* requestEnvironmentVoiceSettings(authorization);
        if (!settings.available) return yield* new VoiceEnvironmentUnavailable();
        return "";
      }
      return yield* transcribeEnvironmentVoiceRecording({
        ...authorization,
        nativeAudioFile: { uri: input.uri, name: "voice-message.m4a", type: "audio/mp4" },
        filename: "voice-message.m4a",
        signal: input.signal,
      });
    }).pipe(Effect.withTracerEnabled(false)),
  { concurrent: true },
);

async function runRequest(input: VoiceRequest) {
  throwIfVoiceTranscriptionAborted(input.signal);
  appAtomRegistry.set(request, input);
  const result = await Effect.runPromise(
    Effect.result(AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true })),
  );
  throwIfVoiceTranscriptionAborted(input.signal);
  if (Result.isSuccess(result)) return result.success;
  if (isVoiceTranscriptionHttpError(result.failure)) {
    throw new VoiceTranscriptionError(
      "transcription-failed",
      voiceTranscriptionFailureMessage(result.failure.reason),
    );
  }
  throw new VoiceTranscriptionError(
    "unavailable",
    "Check voice settings and the connection on this environment.",
  );
}

// Capture the destination once; later selections cannot redirect an existing recording.
export function environmentVoiceTranscriber(
  environmentId: EnvironmentId,
  onError: (message: string) => void,
): VoiceTranscriber {
  const checkedRequest = async (input: VoiceRequest) => {
    try {
      return await runRequest(input);
    } catch (error) {
      if (!input.signal.aborted && error instanceof VoiceTranscriptionError) onError(error.message);
      throw error;
    }
  };
  return {
    prepare: async ({ signal }) => {
      await checkedRequest({ environmentId, signal });
      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: async (uri, { signal: transcriptionSignal }) => {
          throwIfVoiceTranscriptionAborted(transcriptionSignal);
          const file = new File(uri);
          if (!file.exists || file.size <= 0 || file.size > 25 * 1024 * 1024) {
            throw new VoiceTranscriptionError(
              "transcription-failed",
              "Record a shorter voice message and try again.",
            );
          }
          return checkedRequest({ environmentId, signal: transcriptionSignal, uri });
        },
      };
    },
  };
}
