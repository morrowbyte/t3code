import { describe, it, expect, vi } from "vite-plus/test";
import type { LiveVoiceLease } from "@t3tools/client-runtime/live-voice";
import { LiveVoiceRecording, type CallRecordingState } from "./LiveVoiceRecording";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const lease = {
  environmentId: "env-test",
  threadId: "thread-test",
  leaseId: "lease-test",
  generation: 1,
} as LiveVoiceLease;
function harness(
  options: {
    enabled?: boolean;
    uploadFails?: boolean;
    recorderFails?: boolean;
    delayedStop?: boolean;
  } = {},
) {
  const ready = deferred<void>();
  const off = deferred<void>();
  const recorders: Array<{
    stream: unknown;
    recorder: MediaRecorder;
    emit: (data: Blob) => void;
    finishStop: () => void;
  }> = [];
  const requests: Array<{ action: string; input?: unknown; id?: string }> = [];
  const states: CallRecordingState[] = [];
  const request = vi.fn(async (input: { action: string; input?: unknown; id?: string }) => {
    requests.push(input);
    if (input.action === "settings")
      return {
        enabled: options.enabled ?? true,
        hostLabel: "fixture",
        directory: "/fixture/userdata/voice-recordings",
        retentionDays: 3,
      };
    if (input.action === "start")
      return {
        ...lease,
        mimeType: "audio/ogg;codecs=opus",
        id: "11111111-1111-1111-1111-111111111111",
        startedAt: 0,
        endedAt: null,
        bytes: 0,
      };
    if (input.action === "append" && options.uploadFails) throw new Error("disk full");
    return undefined;
  });
  const recording = new LiveVoiceRecording({
    transport: async () => request,
    supportedMime: () => "audio/ogg;codecs=opus",
    now: () => 1000,
    onState: (state) => {
      states.push(state);
      if (state.status === "recording" || state.status === "error") ready.resolve();
      if (state.status === "off") off.resolve();
    },
    recorder: (stream) => {
      if (options.recorderFails) throw new Error("recorder unavailable");
      let state = "inactive";
      const recorder = {
        get state() {
          return state;
        },
        ondataavailable: null,
        onerror: null,
        onstop: null,
        start: vi.fn(() => {
          state = "recording";
        }),
        stop: vi.fn(() => {
          state = "inactive";
          if (!options.delayedStop) recorder.onstop?.({} as Event);
        }),
        pause: vi.fn(() => {
          state = "paused";
        }),
        resume: vi.fn(() => {
          state = "recording";
        }),
      } as unknown as MediaRecorder;
      recorders.push({
        stream,
        recorder,
        emit: (data) => recorder.ondataavailable?.({ data } as BlobEvent),
        finishStop: () => recorder.onstop?.({} as Event),
      });
      return recorder;
    },
  });
  const track = { enabled: true, stop: vi.fn() };
  const user = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const assistant = { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
  return {
    recording,
    recorders,
    requests,
    states,
    request,
    user,
    assistant,
    track,
    ready: ready.promise,
    off: off.promise,
  };
}
describe("call recording observer", () => {
  it("does not construct recorders or create a host recording without opt-in", async () => {
    const h = harness({ enabled: false });
    h.recording.attach(lease, h.user, h.assistant);
    await h.off;
    expect(h.recorders).toHaveLength(0);
    expect(h.requests.map((r) => r.action)).toEqual(["settings"]);
  });
  it("attaches both existing streams, preserves mute, pauses/resumes and flushes both roles", async () => {
    const h = harness();
    h.recording.attach(lease, h.user, h.assistant);
    await h.ready;
    expect(h.recorders.map((r) => r.stream)).toEqual([h.user, h.assistant]);
    h.track.enabled = false;
    expect(h.recorders[0]?.stream).toBe(h.user);
    h.recording.pause();
    expect(h.recorders.map((r) => r.recorder.state)).toEqual(["paused", "paused"]);
    h.recording.attach(lease, h.user, h.assistant);
    expect(h.recorders).toHaveLength(2);
    expect(h.recorders.map((r) => r.recorder.state)).toEqual(["recording", "recording"]);
    h.recorders.forEach((r) => r.emit(new Blob(["synthetic-opus"])));
    await h.recording.finish();
    const chunks = h.requests.filter((r) => r.action === "append").map((r) => r.input);
    expect(chunks).toEqual([
      expect.objectContaining({ role: "user", sequence: 0, offsetMs: 0, trackStartedOffsetMs: 0 }),
      expect.objectContaining({ role: "assistant", sequence: 0 }),
    ]);
    expect(h.track.stop).not.toHaveBeenCalled();
    expect(h.states.at(-1)?.status).toBe("saved");
  });
  it("opt-out discards pending bytes and never restarts the same call", async () => {
    const h = harness();
    h.recording.attach(lease, h.user, h.assistant);
    await h.ready;
    h.recording.disable();
    await h.recording.finish();
    h.recording.attach(lease, h.user, h.assistant);
    expect(h.requests.filter((r) => r.action === "start")).toHaveLength(1);
    expect(h.recorders.every((r) => r.recorder.state === "inactive")).toBe(true);
    expect(h.track.stop).not.toHaveBeenCalled();
  });
  it.each([{ recorderFails: true }, { uploadFails: true }])(
    "isolates recorder/upload failure from media ownership (%j)",
    async (options) => {
      const h = harness(options);
      h.recording.attach(lease, h.user, h.assistant);
      await h.ready;
      h.recorders[0]?.emit(new Blob(["synthetic-opus"]));
      await h.recording.finish();
      expect(h.states.some((s) => s.status === "error")).toBe(true);
      expect(h.track.stop).not.toHaveBeenCalled();
      expect(h.track.enabled).toBe(true);
    },
  );
  it("stops on oversized browser chunks without queueing an unbounded payload", async () => {
    const h = harness();
    h.recording.attach(lease, h.user, h.assistant);
    await h.ready;
    h.recorders[0]?.emit(new Blob([new Uint8Array(256 * 1024 + 1)]));
    await h.recording.finish();
    expect(h.requests.some((r) => r.action === "append")).toBe(false);
    expect(h.states.some((s) => s.status === "error")).toBe(true);
  });
});

it("waits for asynchronous final dataavailable and stop before finalizing the host recording", async () => {
  const h = harness({ delayedStop: true });
  h.recording.attach(lease, h.user, h.assistant);
  await h.ready;
  const finishing = h.recording.finish();
  expect(h.recorders.map((item) => item.recorder.state)).toEqual(["inactive", "inactive"]);
  expect(h.requests.some((request) => request.action === "finish")).toBe(false);
  h.recorders[0]!.emit(new Blob(["final-user"]));
  h.recorders[0]!.finishStop();
  expect(h.requests.some((request) => request.action === "finish")).toBe(false);
  h.recorders[1]!.emit(new Blob(["final-agent"]));
  h.recorders[1]!.finishStop();
  await finishing;
  expect(h.requests.map((request) => request.action)).toEqual([
    "settings",
    "start",
    "append",
    "append",
    "finish",
  ]);
});

it("opt-out discards a chunk still being encoded and all asynchronous final data", async () => {
  const h = harness({ delayedStop: true });
  h.recording.attach(lease, h.user, h.assistant);
  await h.ready;
  const reading = deferred<void>();
  const bytes = deferred<ArrayBuffer>();
  h.recorders[0]!.emit({
    size: 4,
    arrayBuffer: () => {
      reading.resolve();
      return bytes.promise;
    },
  } as Blob);
  await reading.promise;
  h.recording.disable();
  h.recorders.forEach((item) => {
    item.emit(new Blob(["final-private-data"]));
    item.finishStop();
  });
  bytes.resolve(new ArrayBuffer(4));
  await h.recording.finish();
  expect(h.requests.map((request) => request.action)).toEqual(["settings", "start", "finish"]);
  expect(h.track.stop).not.toHaveBeenCalled();
});
