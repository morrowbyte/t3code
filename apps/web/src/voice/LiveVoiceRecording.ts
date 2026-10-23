import {
  VoiceRecordingEntry,
  VoiceRecordingSettings,
  VOICE_RECORDING_CHUNK_BYTES,
  type EnvironmentId,
} from "@t3tools/contracts";
import type {
  LiveVoiceRecordingHooks,
  LiveVoiceMediaStream,
  LiveVoiceLease,
} from "@t3tools/client-runtime/live-voice";
import * as Schema from "effect/Schema";
import { createRecordingTransport, RECORDING_OPT_OUT_EVENT } from "./voiceRecordingClient";

type Recorder = Pick<
  MediaRecorder,
  "start" | "stop" | "pause" | "resume" | "state" | "ondataavailable" | "onerror" | "onstop"
>;
type Transport = Awaited<ReturnType<typeof createRecordingTransport>>;
export type CallRecordingState = {
  status: "off" | "starting" | "recording" | "paused" | "saving" | "saved" | "error";
  error?: string;
};
type Dependencies = {
  transport: (environmentId: EnvironmentId) => Promise<Transport>;
  supportedMime: () => "audio/ogg;codecs=opus" | "audio/webm;codecs=opus" | undefined;
  recorder: (stream: LiveVoiceMediaStream, mimeType: string) => Recorder;
  now: () => number;
  onState: (state: CallRecordingState) => void;
};
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_CHUNKS = 32;
const decodeRecordingSettings = Schema.decodeUnknownSync(VoiceRecordingSettings);
const decodeRecordingEntry = Schema.decodeUnknownSync(VoiceRecordingEntry);

/** Observes the normal call's streams. It never acquires media, plays audio, or stops tracks. */
class RecordingRun implements LiveVoiceRecordingHooks {
  private key: string | null = null;
  private operation = 0;
  private recorders: Recorder[] = [];
  private stopped: Array<{ recorder: Recorder; promise: Promise<void>; resolve: () => void }> = [];
  private request: Transport | null = null;
  private entry: typeof VoiceRecordingEntry.Type | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queuedChunks = 0;
  private failed = false;
  private paused = false;
  private stopping = false;
  private finishing: Promise<void> | null = null;

  constructor(private readonly dependencies: Dependencies) {}
  attach = (
    lease: LiveVoiceLease,
    user: LiveVoiceMediaStream,
    assistant: LiveVoiceMediaStream,
  ): void => {
    const key = `${lease.environmentId}:${lease.leaseId}:${lease.generation}`;
    if (this.key === key) {
      if (this.paused && !this.stopping && !this.failed) {
        try {
          this.recorders.forEach((recorder) => {
            if (recorder.state === "paused") recorder.resume();
          });
          this.paused = false;
          if (this.recorders.length) this.dependencies.onState({ status: "recording" });
        } catch {
          this.fail();
        }
      }
      return;
    }
    this.key = key;
    const operation = ++this.operation;
    this.failed = false;
    this.paused = false;
    this.stopping = false;
    void this.begin(operation, lease, user, assistant);
  };
  private async begin(
    operation: number,
    lease: LiveVoiceLease,
    user: LiveVoiceMediaStream,
    assistant: LiveVoiceMediaStream,
  ) {
    try {
      await this.finishing;
      if (operation !== this.operation || this.stopping) return;
      this.finishing = null;
      this.request = null;
      this.entry = null;
      const request = await this.dependencies.transport(lease.environmentId);
      const settings = decodeRecordingSettings(await request({ action: "settings" }));
      if (operation !== this.operation || this.stopping) return;
      if (!settings.enabled) {
        this.dependencies.onState({ status: "off" });
        return;
      }
      const mimeType = this.dependencies.supportedMime();
      if (!mimeType) throw new Error("Unsupported recorder");
      this.dependencies.onState({ status: "starting" });
      const entry = decodeRecordingEntry(
        await request({
          action: "start",
          input: {
            environmentId: lease.environmentId,
            threadId: lease.threadId,
            leaseId: lease.leaseId,
            generation: lease.generation,
            mimeType,
          },
        }),
      );
      if (operation !== this.operation || this.stopping) {
        await request({ action: "finish", id: entry.id });
        return;
      }
      this.request = request;
      this.entry = entry;
      this.queue = Promise.resolve();
      this.queuedBytes = 0;
      this.queuedChunks = 0;
      const origin = this.dependencies.now();
      for (const [role, stream] of [
        ["user", user],
        ["assistant", assistant],
      ] as const) {
        const recorder = this.dependencies.recorder(stream, mimeType);
        this.recorders.push(recorder);
        let sequence = 0;
        const trackStartedOffsetMs = Math.round(this.dependencies.now() - origin);
        let resolveStop!: () => void;
        const stopped = new Promise<void>((resolve) => {
          resolveStop = resolve;
          recorder.onstop = () => resolve();
        });
        this.stopped.push({ recorder, promise: stopped, resolve: resolveStop });
        // eslint-disable-next-line unicorn/prefer-add-event-listener -- Each recorder belongs to one call observer.
        recorder.onerror = () => this.fail();
        recorder.ondataavailable = ({ data }) => {
          if (!data.size || this.failed) return;
          if (
            data.size > VOICE_RECORDING_CHUNK_BYTES ||
            this.queuedBytes + data.size > MAX_QUEUED_BYTES ||
            this.queuedChunks >= MAX_QUEUED_CHUNKS
          ) {
            this.fail();
            return;
          }
          const offsetMs = Math.round(this.dependencies.now() - origin);
          const currentSequence = sequence++;
          this.queuedBytes += data.size;
          this.queuedChunks += 1;
          this.queue = this.queue.then(async () => {
            try {
              if (this.failed) return;
              const bytes = new Uint8Array(await data.arrayBuffer());
              if (this.failed) return;
              let binary = "";
              for (const byte of bytes) binary += String.fromCharCode(byte);
              await request({
                action: "append",
                input: {
                  id: entry.id,
                  role,
                  sequence: currentSequence,
                  offsetMs,
                  trackStartedOffsetMs,
                  data: btoa(binary),
                },
              });
            } catch {
              this.fail();
            } finally {
              this.queuedBytes -= data.size;
              this.queuedChunks -= 1;
            }
          });
        };
        recorder.start(1000);
        if (this.paused) recorder.pause();
      }
      this.dependencies.onState({ status: this.paused ? "paused" : "recording" });
    } catch {
      if (operation === this.operation && !this.stopping) this.fail();
    }
  }
  pause = (): void => {
    this.paused = true;
    try {
      this.recorders.forEach((recorder) => {
        if (recorder.state === "recording") recorder.pause();
      });
      if (this.recorders.length) this.dependencies.onState({ status: "paused" });
    } catch {
      this.fail();
    }
  };
  stop = (): void => {
    void this.finish();
  };
  disable = (): void => {
    this.failed = true;
    void this.finish().then(() => this.dependencies.onState({ status: "off" }));
  };
  private fail() {
    this.failed = true;
    this.dependencies.onState({
      status: "error",
      error: "Recording stopped. Check Voice settings or host storage.",
    });
    void this.finish();
  }
  async finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.stopping = true;
    ++this.operation;
    if (this.recorders.length && !this.failed) this.dependencies.onState({ status: "saving" });
    for (const stopped of this.stopped) {
      // stop() changes state synchronously; final data and stop arrive later.
      if (stopped.recorder.state === "inactive") stopped.resolve();
      else {
        try {
          stopped.recorder.stop();
        } catch {
          this.failed = true;
          stopped.resolve();
        }
      }
    }
    this.finishing = (async () => {
      await Promise.all(this.stopped.map((item) => item.promise));
      await this.queue;
      if (this.request && this.entry) {
        try {
          await this.request({ action: "finish", id: this.entry.id });
          if (!this.failed) this.dependencies.onState({ status: "saved" });
        } catch {
          this.dependencies.onState({
            status: "error",
            error: "Recording could not finish saving on the host.",
          });
        }
      }
      this.recorders = [];
      this.stopped = [];
    })();
    return this.finishing;
  }
}

export class LiveVoiceRecording implements LiveVoiceRecordingHooks {
  private current: { key: string; run: RecordingRun } | null = null;
  constructor(private readonly dependencies: Dependencies) {}
  attach = (
    lease: LiveVoiceLease,
    user: LiveVoiceMediaStream,
    assistant: LiveVoiceMediaStream,
  ): void => {
    const key = `${lease.environmentId}:${lease.leaseId}:${lease.generation}`;
    if (this.current?.key !== key) {
      this.current?.run.stop();
      const run = new RecordingRun({
        ...this.dependencies,
        onState: (state) => {
          if (this.current?.run === run) this.dependencies.onState(state);
        },
      });
      this.current = { key, run };
    }
    this.current.run.attach(lease, user, assistant);
  };
  pause = (): void => {
    this.current?.run.pause();
  };
  stop = (): void => {
    this.current?.run.stop();
  };
  disable = (): void => {
    this.current?.run.disable();
  };
  async finish(): Promise<void> {
    await this.current?.run.finish();
  }
}

export function createBrowserCallRecording(onState: Dependencies["onState"]) {
  const recording = new LiveVoiceRecording({
    transport: createRecordingTransport,
    supportedMime: () =>
      typeof MediaRecorder === "undefined"
        ? undefined
        : (["audio/ogg;codecs=opus", "audio/webm;codecs=opus"] as const).find((mime) =>
            MediaRecorder.isTypeSupported(mime),
          ),
    recorder: (stream, mimeType) =>
      new MediaRecorder(stream as MediaStream, { mimeType, audioBitsPerSecond: 48_000 }),
    now: () => performance.now(),
    onState,
  });
  return recording;
}

export function observeRecordingOptOut(environmentId: string, recording: LiveVoiceRecording) {
  const listener = (event: Event) => {
    if ((event as CustomEvent).detail === environmentId) recording.disable();
  };
  const channel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(RECORDING_OPT_OUT_EVENT);
  channel?.addEventListener("message", (event) => {
    if (event.data === environmentId) recording.disable();
  });
  window.addEventListener(RECORDING_OPT_OUT_EVENT, listener);
  return () => {
    window.removeEventListener(RECORDING_OPT_OUT_EVENT, listener);
    channel?.close();
  };
}
