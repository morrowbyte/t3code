import { expect, it, vi } from "vite-plus/test";
import { BrowserVoiceAudio } from "./BrowserVoiceAudio";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function capture() {
  const track = Object.assign(new EventTarget(), {
    readyState: "live",
    muted: false,
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}
function harness() {
  const first = capture();
  const replacement = capture();
  const processed = capture();
  const getUserMedia = vi.fn().mockResolvedValue(first.stream);
  const source = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const gain = { ...source(), gain: { value: 1 } };
  const context = {
    state: "running",
    onstatechange: null as (() => void) | null,
    createMediaStreamSource: vi.fn(source),
    createGain: () => gain,
    createAnalyser: () => ({ ...source(), fftSize: 256 }),
    createMediaStreamDestination: () => ({ stream: processed.stream }),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  context.resume.mockImplementation(async () => {
    context.state = "running";
    context.onstatechange?.();
  });
  const sink = { volume: 1, setSinkId: vi.fn().mockResolvedValue(undefined) };
  const devices = {
    getUserMedia,
    selectAudioOutput: vi.fn(),
    enumerateDevices: vi.fn().mockResolvedValue([]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const audio = new BrowserVoiceAudio({
    devices: () => devices as unknown as MediaDevices,
    context: () => context as unknown as AudioContext,
    sink: () => sink as unknown as HTMLAudioElement,
  });
  return { audio, first, replacement, processed, getUserMedia, context, gain, sink, devices };
}

it("switches microphones without replacing the call/recording stream and keeps mute and gain separate", async () => {
  const h = harness();
  const stream = await h.audio.getUserMedia();
  h.audio.createAudioSink();
  h.audio.setInputGain(1.5);
  h.audio.setOutputVolume(0.25);
  h.getUserMedia.mockResolvedValue(h.replacement.stream);
  await h.audio.selectMicrophone("bluetooth-mic");
  expect(stream).toBe(h.processed.stream);
  expect(h.first.track.stop).toHaveBeenCalledOnce();
  expect(h.processed.track.stop).not.toHaveBeenCalled();
  expect(h.gain.gain.value).toBe(1.5);
  expect(h.sink.volume).toBe(0.25);
  for (const state of ["suspended", "interrupted"]) {
    h.context.state = state;
    h.context.onstatechange?.();
    expect(h.audio.getSnapshot().inputIssue).toBe("suspended");
    await h.audio.resume();
    expect(h.audio.getSnapshot().inputIssue).toBeNull();
  }
  expect(h.getUserMedia).toHaveBeenLastCalledWith({
    audio: { deviceId: { exact: "bluetooth-mic" } },
  });
  h.first.track.dispatchEvent(new Event("ended"));
  expect(h.audio.getSnapshot().inputIssue).toBeNull();
  h.replacement.track.readyState = "ended";
  h.replacement.track.dispatchEvent(new Event("ended"));
  expect(h.audio.getSnapshot().inputIssue).toBe("ended");
  h.audio.release();
  expect(h.replacement.track.stop).toHaveBeenCalledOnce();
  expect(h.processed.track.stop).toHaveBeenCalledOnce();
  expect(h.context.close).toHaveBeenCalledOnce();
});

it("stops a replacement granted after hangup and cannot attach it to the ended call", async () => {
  const h = harness();
  await h.audio.getUserMedia();
  const permission = deferred<MediaStream>();
  h.getUserMedia.mockReturnValue(permission.promise);
  const changing = h.audio.selectMicrophone("new-mic");
  h.audio.release();
  permission.resolve(h.replacement.stream);
  await changing;
  expect(h.replacement.track.stop).toHaveBeenCalledOnce();
  expect(h.audio.getSnapshot()).toMatchObject({ microphone: "", busy: false });
  expect(h.context.createMediaStreamSource).toHaveBeenCalledOnce();
});

it("preserves confirmed devices on request failure and refreshes labels after a permission grant", async () => {
  const h = harness();
  await h.audio.requestPermission();
  expect(h.first.track.stop).toHaveBeenCalledOnce();
  expect(h.devices.enumerateDevices).toHaveBeenCalledOnce();
  expect(h.audio.getSnapshot().permission).toBe("granted");
  await h.audio.selectMicrophone("known-mic");
  await h.audio.selectSpeaker("known-speaker");
  h.audio.createAudioSink();
  h.sink.setSinkId.mockRejectedValue(new Error("device removed"));
  await h.audio.selectSpeaker("missing-speaker");
  expect(h.audio.getSnapshot()).toMatchObject({
    speaker: "known-speaker",
    error: expect.stringContaining("system audio"),
  });
  h.getUserMedia.mockResolvedValue(h.replacement.stream);
  await h.audio.getUserMedia();
  h.getUserMedia.mockRejectedValue(new DOMException("device missing", "NotFoundError"));
  await h.audio.selectMicrophone("missing-mic");
  expect(h.audio.getSnapshot()).toMatchObject({
    microphone: "known-mic",
    error: expect.stringContaining("unavailable"),
  });
  expect(h.replacement.track.stop).not.toHaveBeenCalled();
  h.audio.release();
});

it("releases a late initial permission grant without creating a graph after hangup", async () => {
  const h = harness();
  const permission = deferred<MediaStream>();
  h.getUserMedia.mockReturnValue(permission.promise);
  const starting = h.audio.getUserMedia();
  const rejected = expect(starting).rejects.toThrow("Call ended");
  h.audio.release();
  permission.resolve(h.first.stream);
  await rejected;
  expect(h.first.track.stop).toHaveBeenCalledOnce();
  expect(h.context.createMediaStreamSource).not.toHaveBeenCalled();
});

it("requests output permission before selecting speakers that enumeration cannot expose", async () => {
  const h = harness();
  const speaker = { kind: "audiooutput", deviceId: "hdmi", label: "HDMI display" };
  h.devices.selectAudioOutput.mockResolvedValue(speaker);
  h.devices.enumerateDevices.mockResolvedValue([speaker]);
  await h.audio.refresh();
  expect(h.audio.getSnapshot().outputPermissionSupported).toBe(true);
  await h.audio.requestSpeakerPermission();
  expect(h.devices.selectAudioOutput).toHaveBeenCalledOnce();
  expect(h.getUserMedia).not.toHaveBeenCalled();
  expect(h.sink.setSinkId).toHaveBeenCalledWith("hdmi");
  expect(h.audio.getSnapshot()).toMatchObject({ speaker: "hdmi", devices: [speaker] });
  h.devices.selectAudioOutput.mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));
  await h.audio.requestSpeakerPermission();
  expect(h.audio.getSnapshot().speaker).toBe("hdmi");
  expect(h.audio.getSnapshot().error).toContain("speaker");
});

it("ignores an output permission response after the call ends", async () => {
  const h = harness();
  const permission = deferred<MediaDeviceInfo>();
  h.devices.selectAudioOutput.mockReturnValue(permission.promise);
  const selecting = h.audio.requestSpeakerPermission();
  h.audio.release();
  permission.resolve({ deviceId: "late-speaker" } as MediaDeviceInfo);
  await selecting;
  expect(h.sink.setSinkId).not.toHaveBeenCalled();
  expect(h.audio.getSnapshot().speaker).toBe("");
});

it("reports system-controlled volume without confirming an ineffective slider value", async () => {
  const h = harness();
  Object.defineProperty(h.sink, "volume", { get: () => 1, set: () => {} });
  await h.audio.refresh();
  expect(h.audio.getSnapshot().outputVolumeSupported).toBe(false);
  h.audio.createAudioSink();
  h.audio.setOutputVolume(0);
  expect(h.audio.getSnapshot()).toMatchObject({ outputVolume: 1, outputVolumeSupported: false });
  expect(h.sink.volume).toBe(1);
});
