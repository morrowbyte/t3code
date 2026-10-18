import type { LiveVoiceAudioSink } from "@t3tools/client-runtime/live-voice";

type NativeAudioTrack = { enabled: boolean; stop(): void; release(): void };
type NativeAudioStream = {
  getTracks(): NativeAudioTrack[];
  getAudioTracks(): NativeAudioTrack[];
  release(releaseTracks?: boolean): void;
};

// RN's stop only disables capture; release also frees the native microphone source.
export function releaseNativeStreamOnStop(stream: NativeAudioStream): void {
  const pending = new Set(stream.getTracks());
  for (const track of pending) {
    const stop = track.stop.bind(track);
    track.stop = () => {
      if (!pending.delete(track)) return;
      try {
        stop();
      } catch {}
      try {
        track.release();
      } catch {}
      if (pending.size === 0) {
        try {
          stream.release(false);
        } catch {}
      }
    };
  }
}

// Native WebRTC plays remote audio itself; the sink controls its real receiver tracks.
export function createNativeAudioSink(): LiveVoiceAudioSink {
  let source: LiveVoiceAudioSink["srcObject"] = null;
  let muted = false;
  let playing = false;
  const tracks = () => (source as unknown as NativeAudioStream | null)?.getAudioTracks() ?? [];
  const update = () => {
    for (const track of tracks()) track.enabled = playing && !muted;
  };
  return {
    autoplay: true,
    get srcObject() {
      return source;
    },
    set srcObject(next) {
      for (const track of tracks()) track.enabled = false;
      source = next;
      update();
    },
    get muted() {
      return muted;
    },
    set muted(next) {
      muted = next;
      update();
    },
    play: async () => {
      playing = true;
      update();
    },
    pause: () => {
      playing = false;
      update();
    },
  };
}
