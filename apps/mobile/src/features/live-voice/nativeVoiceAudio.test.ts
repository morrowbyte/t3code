import { describe, expect, it, vi } from "vite-plus/test";
import { createNativeAudioSink, releaseNativeStreamOnStop } from "./nativeVoiceAudio";

describe("native voice audio boundary", () => {
  it("releases every native track and its stream exactly once, including repeated Stop", () => {
    const tracks = Array.from({ length: 2 }, () => ({
      enabled: true,
      stop: vi.fn(),
      release: vi.fn(),
    }));
    const stops = tracks.map((track) => track.stop);
    const stream = { getTracks: () => tracks, getAudioTracks: () => tracks, release: vi.fn() };
    releaseNativeStreamOnStop(stream);
    tracks[0]!.stop();
    tracks[0]!.stop();
    expect(stream.release).not.toHaveBeenCalled();
    tracks[1]!.stop();
    tracks[1]!.stop();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    for (const track of tracks) expect(track.release).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("mutes actual receiver tracks, survives track replacement, and silences on End", async () => {
    const first = { enabled: true };
    const second = { enabled: true };
    const sink = createNativeAudioSink();
    sink.srcObject = { getAudioTracks: () => [first] } as unknown as MediaStream;
    expect(first.enabled).toBe(false);
    await sink.play();
    expect(first.enabled).toBe(true);
    sink.muted = true;
    expect(first.enabled).toBe(false);
    sink.srcObject = { getAudioTracks: () => [second] } as unknown as MediaStream;
    await sink.play();
    expect(second.enabled).toBe(false);
    sink.muted = false;
    expect(second.enabled).toBe(true);
    sink.pause();
    sink.srcObject = null;
    expect(second.enabled).toBe(false);
    expect(sink.srcObject).toBeNull();
  });

  it("continues cleanup when one native track is already gone", () => {
    const track = {
      enabled: true,
      stop: () => {
        throw new Error("released");
      },
      release: vi.fn(),
    };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track], release: vi.fn() };
    releaseNativeStreamOnStop(stream);
    expect(() => track.stop()).not.toThrow();
    expect(track.release).toHaveBeenCalledOnce();
    expect(stream.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
