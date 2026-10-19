import { describe, expect, it, vi } from "vite-plus/test";
import { createNativeAudioSink, releaseNativeStreamOnStop } from "./nativeVoiceAudio";

describe("native voice audio boundary", () => {
  it("lets the stream detach tracks before disposal, including repeated Stop", () => {
    const order: string[] = [];
    const tracks = Array.from({ length: 2 }, (_, id) => ({
      enabled: true,
      stop: vi.fn(),
      release: vi.fn(() => order.push(`release:${id}`)),
    }));
    const stops = tracks.map((track) => track.stop);
    const stream = {
      getTracks: () => tracks,
      getAudioTracks: () => tracks,
      release: vi.fn((releaseTracks = true) => {
        tracks.forEach((track, id) => {
          order.push(`detach:${id}`);
          if (releaseTracks) track.release();
        });
      }),
    };
    releaseNativeStreamOnStop(stream);
    tracks[0]!.stop();
    tracks[0]!.stop();
    expect(stream.release).not.toHaveBeenCalled();
    tracks[1]!.stop();
    tracks[1]!.stop();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    for (const track of tracks) expect(track.release).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledExactlyOnceWith();
    expect(order).toEqual(["detach:0", "release:0", "detach:1", "release:1"]);
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

  it("still releases the stream when disabling capture throws", () => {
    const track = {
      enabled: true,
      stop: () => {
        throw new Error("released");
      },
      release: vi.fn(),
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      release: vi.fn(() => track.release()),
    };
    releaseNativeStreamOnStop(stream);
    expect(() => track.stop()).not.toThrow();
    expect(track.release).toHaveBeenCalledOnce();
    expect(stream.release).toHaveBeenCalledExactlyOnceWith();
  });
  it("ends the foreground lifetime once after final track disposal even when disposal fails", () => {
    const track = { enabled: true, stop: vi.fn() };
    const end = vi.fn();
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      release: () => {
        throw new Error("disposed");
      },
    };
    releaseNativeStreamOnStop(stream, end);
    track.stop();
    track.stop();
    expect(end).toHaveBeenCalledOnce();
  });

  it("releases an empty native stream and its foreground lifetime immediately", () => {
    const end = vi.fn();
    const stream = { getTracks: () => [], getAudioTracks: () => [], release: vi.fn() };
    releaseNativeStreamOnStop(stream, end);
    expect(stream.release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
