import { acquireMicrophoneOwnership } from "@t3tools/client-runtime/live-voice";
import type {
  PreparedVoiceTranscription,
  VoiceRecorder,
  VoiceStreamingSession,
  VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import workletUrl from "./pcmWorklet.ts?worker&url";

type PreparedBrowserTranscription = PreparedVoiceTranscription & {
  readonly streaming?: VoiceStreamingSession & { readonly feed: (pcm: Float32Array) => void };
};

type BrowserCapture = {
  readonly signal: AbortSignal;
  readonly releaseMicrophone: () => void;
  readonly feed: ((pcm: Float32Array) => void) | undefined;
  chunks: Float32Array<ArrayBuffer>[];
  permissionPending: boolean;
  cancelled: boolean;
  cancelPreparation?: (() => void) | undefined;
  removeAbortListener?: (() => void) | undefined;
  stream?: MediaStream | undefined;
  audioContext?: AudioContext | undefined;
  worklet?: AudioWorkletNode | undefined;
  durationTimer?: ReturnType<typeof setTimeout> | undefined;
  stopped?: { readonly resolve: () => void; readonly reject: (error: Error) => void } | undefined;
};

export function createBrowserPcmCapture(
  input: {
    readonly getMicrophoneId: () => string;
    readonly onLevel: (level: number) => void;
    readonly onDurationLimit: () => void;
    readonly onError: (message: string) => void;
  },
  prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedBrowserTranscription>,
) {
  let activeCapture: BrowserCapture | undefined;
  let recordingUri: string | null = null;
  let signal: AbortSignal | undefined;
  let feed: ((pcm: Float32Array) => void) | undefined;

  const cleanupCapture = (capture = activeCapture) => {
    if (!capture) return;
    capture.cancelled = true;
    capture.cancelPreparation?.();
    capture.cancelPreparation = undefined;
    capture.removeAbortListener?.();
    capture.removeAbortListener = undefined;
    if (capture.durationTimer) clearTimeout(capture.durationTimer);
    capture.durationTimer = undefined;
    capture.worklet?.disconnect();
    capture.worklet?.port.close();
    capture.worklet = undefined;
    capture.stream?.getTracks().forEach((track) => track.stop());
    capture.stream = undefined;
    void capture.audioContext?.close();
    capture.audioContext = undefined;
    capture.stopped?.resolve();
    capture.stopped = undefined;
    capture.chunks = [];
    // getUserMedia cannot be cancelled; its late stream must stop before ownership is released.
    if (!capture.permissionPending) capture.releaseMicrophone();
    if (activeCapture === capture) {
      activeCapture = undefined;
      input.onLevel(0);
    }
  };

  const recorder: VoiceRecorder = {
    get uri() {
      return recordingUri;
    },
    prepareToRecordAsync: async () => {
      const captureSignal = signal;
      if (!captureSignal) throw new Error("Voice transcription is not prepared.");
      captureSignal.throwIfAborted();
      const releaseMicrophone = acquireMicrophoneOwnership();
      if (!releaseMicrophone) throw new Error("The microphone is already in use.");
      const capture: BrowserCapture = {
        signal: captureSignal,
        releaseMicrophone,
        feed,
        chunks: [],
        permissionPending: false,
        cancelled: false,
      };
      activeCapture = capture;
      const cancelled = new Promise<never>((_, reject) => {
        capture.cancelPreparation = () =>
          reject(captureSignal.reason ?? new DOMException("Recording cancelled.", "AbortError"));
      });
      void cancelled.catch(() => undefined);
      const onAbort = () => cleanupCapture(capture);
      captureSignal.addEventListener("abort", onAbort, { once: true });
      capture.removeAbortListener = () => captureSignal.removeEventListener("abort", onAbort);
      if (captureSignal.aborted) onAbort();
      try {
        if (recordingUri) URL.revokeObjectURL(recordingUri);
        recordingUri = null;
        const microphoneId = input.getMicrophoneId();
        const permission = new Promise<MediaStream>((resolve, reject) => {
          if (capture.cancelled) {
            reject(captureSignal.reason ?? new DOMException("Recording cancelled.", "AbortError"));
            return;
          }
          let mediaRequest: Promise<MediaStream>;
          try {
            capture.permissionPending = true;
            mediaRequest = navigator.mediaDevices.getUserMedia({
              audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
            });
          } catch (error) {
            capture.permissionPending = false;
            reject(error);
            return;
          }
          void mediaRequest.then(
            (media) => {
              capture.permissionPending = false;
              capture.stream = media;
              if (capture.cancelled || captureSignal.aborted) {
                cleanupCapture(capture);
                reject(
                  captureSignal.reason ?? new DOMException("Recording cancelled.", "AbortError"),
                );
              } else resolve(media);
            },
            (error: unknown) => {
              capture.permissionPending = false;
              reject(error);
              cleanupCapture(capture);
            },
          );
        });
        const captured = await Promise.race([permission, cancelled]);
        captureSignal.throwIfAborted();
        if (capture.cancelled) throw new DOMException("Recording cancelled.", "AbortError");
        const context = new AudioContext();
        capture.audioContext = context;
        await Promise.race([context.audioWorklet.addModule(workletUrl), cancelled]);
        captureSignal.throwIfAborted();
        if (capture.cancelled) throw new DOMException("Recording cancelled.", "AbortError");
        const node = new AudioWorkletNode(context, "t3-pcm-capture", { channelCount: 1 });
        capture.worklet = node;
        const isCurrent = () =>
          activeCapture === capture && !capture.cancelled && !captureSignal.aborted;
        node.port.onmessage = ({
          data,
        }: MessageEvent<Float32Array<ArrayBuffer> | number | "stopped" | "limit">) => {
          if (!isCurrent()) return;
          if (data === "stopped") {
            capture.stopped?.resolve();
            return;
          }
          if (data === "limit") {
            input.onDurationLimit();
            return;
          }
          if (typeof data === "number") {
            input.onLevel(data);
            return;
          }
          if (capture.feed) capture.feed(data);
          else capture.chunks.push(data);
        };
        const fail = (message: string) => {
          if (!isCurrent()) return;
          capture.stopped?.reject(new Error(message));
          cleanupCapture(capture);
          input.onError(message);
        };
        node.onprocessorerror = () => fail("Microphone processing failed.");
        for (const track of captured.getTracks())
          track.addEventListener("ended", () => fail("The microphone disconnected."), {
            once: true,
          });
        context.createMediaStreamSource(captured).connect(node);
        // The processor emits silence, keeping the graph active without microphone playback.
        node.connect(context.destination);
        await Promise.race([context.resume(), cancelled]);
        captureSignal.throwIfAborted();
        if (capture.cancelled) throw new DOMException("Recording cancelled.", "AbortError");
      } catch (error) {
        cleanupCapture(capture);
        throw error;
      }
    },
    record: ({ forDuration }) => {
      const capture = activeCapture;
      if (!capture) return;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      capture.worklet?.port.postMessage("start");
      capture.durationTimer = setTimeout(input.onDurationLimit, forDuration * 1_000);
    },
    stop: async () => {
      const capture = activeCapture;
      if (!capture) return;
      if (!capture.worklet || capture.signal.aborted) {
        cleanupCapture(capture);
        return;
      }
      const pending = new Promise<void>((resolve, reject) => {
        capture.stopped = { resolve, reject };
      });
      const timeout = setTimeout(
        () => capture.stopped?.reject(new Error("Microphone capture did not stop.")),
        5_000,
      );
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        capture.worklet.port.postMessage("stop");
        await pending;
        if (!capture.cancelled && !capture.feed && capture.chunks.length) {
          const blob = new Blob(capture.chunks, { type: "application/octet-stream" });
          recordingUri = URL.createObjectURL(blob);
        }
      } finally {
        clearTimeout(timeout);
        cleanupCapture(capture);
      }
    },
  };

  return {
    recorder,
    cancelRecording: () => cleanupCapture(),
    deleteRecording: (uri: string) => {
      URL.revokeObjectURL(uri);
      if (recordingUri === uri) recordingUri = null;
    },
    transcriber: {
      prepare: async (options: VoiceTranscriptionOptions) => {
        const prepared = await prepare(options);
        options.signal.throwIfAborted();
        signal = options.signal;
        feed = prepared.streaming?.feed;
        return prepared;
      },
    },
  };
}
