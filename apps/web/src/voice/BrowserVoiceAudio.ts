import { acquireMicrophoneOwnership } from "@t3tools/client-runtime/live-voice";

type AudioState = {
  readonly devices: ReadonlyArray<MediaDeviceInfo>;
  readonly microphone: string;
  readonly speaker: string;
  readonly inputGain: number;
  readonly outputVolume: number;
  readonly permission: "unknown" | "granted" | "denied";
  readonly busy: boolean;
  readonly error: string | null;
  readonly outputSelectionSupported: boolean;
  readonly outputPermissionSupported: boolean;
  readonly outputVolumeSupported: boolean;
  readonly inputIssue: "ended" | "muted" | "suspended" | null;
};
type Dependencies = {
  readonly devices: () => MediaDevices | undefined;
  readonly context: () => AudioContext;
  readonly sink: () => HTMLAudioElement;
};
type SpeakerDevices = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};

const supportsVolume = (audio: HTMLAudioElement) => {
  const original = audio.volume;
  audio.volume = 0.5;
  const supported = audio.volume === 0.5;
  audio.volume = original;
  return supported;
};

const stop = (stream: MediaStream | null) => stream?.getTracks().forEach((track) => track.stop());
const audioError = (error: unknown) =>
  error instanceof Error && error.name === "NotAllowedError"
    ? "Allow microphone access in your browser’s site settings, then try again."
    : error instanceof Error && error.name === "NotFoundError"
      ? "This microphone is unavailable. Connect it in system settings or choose another device."
      : "Could not use this audio device. Check system audio settings, then try again.";

export class BrowserVoiceAudio {
  private state: AudioState = {
    devices: [],
    microphone: "",
    speaker: "",
    inputGain: 1,
    outputVolume: 1,
    permission: "unknown",
    busy: false,
    error: null,
    outputSelectionSupported: false,
    outputPermissionSupported: false,
    outputVolumeSupported: false,
    inputIssue: null,
  };
  private readonly listeners = new Set<() => void>();
  private context: AudioContext | null = null;
  private capture: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private inputMeter: AnalyserNode | null = null;
  private outputMeter: AnalyserNode | null = null;
  private outputSource: MediaStreamAudioSourceNode | null = null;
  private audio: HTMLAudioElement | null = null;
  private operation = 0;
  private selection = 0;
  private outputSelection = 0;
  private unwatchCapture: (() => void) | null = null;

  constructor(
    private readonly dependencies: Dependencies = {
      devices: () => navigator.mediaDevices,
      context: () => new AudioContext(),
      sink: () => document.createElement("audio"),
    },
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<AudioState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  refresh = async () => {
    try {
      const mediaDevices: SpeakerDevices | undefined = this.dependencies.devices();
      const devices = await mediaDevices?.enumerateDevices();
      const sink = this.dependencies.sink();
      this.update({
        devices: devices ?? [],
        outputSelectionSupported: typeof sink.setSinkId === "function",
        outputPermissionSupported: typeof mediaDevices?.selectAudioOutput === "function",
        outputVolumeSupported: supportsVolume(sink),
      });
    } catch (error) {
      this.update({ error: audioError(error) });
    }
  };
  observeDevices = () => {
    const devices = this.dependencies.devices();
    const refresh = () => {
      void this.refresh();
    };
    devices?.addEventListener("devicechange", refresh);
    void this.refresh();
    return () => devices?.removeEventListener("devicechange", refresh);
  };
  requestPermission = async () => {
    if (this.capture || this.state.busy) return;
    const release = acquireMicrophoneOwnership();
    if (!release) {
      this.update({ error: "Another microphone session is active." });
      return;
    }
    this.update({ busy: true, error: null });
    let stream: MediaStream | null = null;
    try {
      stream = await this.requestCapture();
      this.update({ permission: "granted" });
    } catch (error) {
      this.update({ permission: "denied", error: audioError(error) });
    } finally {
      stop(stream);
      release();
      this.update({ busy: false });
      await this.refresh();
    }
  };
  private requestCapture(device = this.state.microphone) {
    const devices = this.dependencies.devices();
    if (!devices) throw new Error("Microphone access requires a secure browser connection.");
    return devices.getUserMedia({ audio: device ? { deviceId: { exact: device } } : true });
  }
  private watchCapture(stream: MediaStream) {
    this.unwatchCapture?.();
    const tracks = stream.getAudioTracks();
    const update = () =>
      this.update({
        inputIssue:
          this.context?.state === "suspended" || (this.context?.state as string) === "interrupted"
            ? "suspended"
            : tracks.some((track) => track.readyState === "ended")
              ? "ended"
              : tracks.some((track) => track.muted)
                ? "muted"
                : null,
      });
    for (const track of tracks) {
      track.addEventListener("ended", update);
      track.addEventListener("mute", update);
      track.addEventListener("unmute", update);
    }
    this.unwatchCapture = () => {
      for (const track of tracks) {
        track.removeEventListener("ended", update);
        track.removeEventListener("mute", update);
        track.removeEventListener("unmute", update);
      }
    };
    if (this.context) this.context.onstatechange = update;
    update();
  }
  getUserMedia = async () => {
    const operation = ++this.operation;
    this.update({ error: null });
    const stream = await this.requestCapture().catch((error: unknown) => {
      this.update({ permission: "denied", error: audioError(error) });
      throw error;
    });
    if (operation !== this.operation) {
      stop(stream);
      throw new Error("Call ended.");
    }
    this.capture = stream;
    try {
      const context = this.dependencies.context();
      this.context = context;
      this.watchCapture(stream);
      this.source = context.createMediaStreamSource(stream);
      this.gain = context.createGain();
      this.gain.gain.value = this.state.inputGain;
      this.inputMeter = context.createAnalyser();
      this.inputMeter.fftSize = 256;
      this.destination = context.createMediaStreamDestination();
      this.source.connect(this.gain);
      this.gain.connect(this.inputMeter);
      this.gain.connect(this.destination);
      await context.resume();
      if (operation !== this.operation) throw new Error("Call ended.");
      this.update({ permission: "granted" });
      void this.refresh();
      return this.destination.stream;
    } catch (error) {
      this.release();
      throw error;
    }
  };
  selectMicrophone = async (microphone: string) => {
    if (this.state.busy) return;
    if (!this.capture) {
      this.update({ microphone });
      return;
    }
    const operation = this.operation;
    const selection = ++this.selection;
    this.update({ busy: true, error: null });
    let next: MediaStream | null = null;
    try {
      next = await this.requestCapture(microphone);
      if (
        operation !== this.operation ||
        selection !== this.selection ||
        !this.context ||
        !this.gain
      ) {
        stop(next);
        return;
      }
      const source = this.context.createMediaStreamSource(next);
      source.connect(this.gain);
      this.source?.disconnect();
      this.unwatchCapture?.();
      stop(this.capture);
      this.capture = next;
      this.source = source;
      this.watchCapture(next);
      this.update({ microphone, permission: "granted" });
      await this.refresh();
    } catch (error) {
      stop(next);
      this.update({ error: audioError(error) });
    } finally {
      this.update({ busy: false });
    }
  };
  createAudioSink = () => {
    const audio = this.dependencies.sink();
    audio.autoplay = true;
    audio.volume = this.state.outputVolume;
    this.audio = audio;
    this.update({
      outputSelectionSupported: typeof audio.setSinkId === "function",
      outputVolumeSupported: supportsVolume(audio),
      outputVolume: audio.volume,
    });
    if (this.state.speaker && audio.setSinkId)
      void audio
        .setSinkId(this.state.speaker)
        .catch((error: unknown) => this.update({ error: audioError(error) }));
    return audio;
  };
  selectSpeaker = async (speaker: string) => {
    const audio = this.audio ?? this.dependencies.sink();
    if (!audio.setSinkId) return;
    const selection = ++this.outputSelection;
    const operation = this.operation;
    try {
      await audio.setSinkId(speaker);
      if (selection === this.outputSelection && operation === this.operation)
        this.update({ speaker, error: null });
    } catch (error) {
      if (selection === this.outputSelection && operation === this.operation)
        this.update({ error: audioError(error) });
    }
  };
  requestSpeakerPermission = async () => {
    const devices: SpeakerDevices | undefined = this.dependencies.devices();
    if (!devices?.selectAudioOutput) return;
    const selection = ++this.outputSelection;
    const operation = this.operation;
    this.update({ error: null });
    try {
      const device = await devices.selectAudioOutput();
      if (selection !== this.outputSelection || operation !== this.operation) return;
      await this.selectSpeaker(device.deviceId);
      await this.refresh();
    } catch {
      if (selection === this.outputSelection && operation === this.operation)
        this.update({
          error:
            "Could not select a speaker. Allow speaker access in your browser, then try again.",
        });
    }
  };
  resume = async () => {
    try {
      await this.context?.resume();
    } catch (error) {
      this.update({ error: audioError(error) });
    }
  };
  setInputGain = (inputGain: number) => {
    if (this.gain) this.gain.gain.value = inputGain;
    this.update({ inputGain });
  };
  setOutputVolume = (outputVolume: number) => {
    const audio = this.audio ?? this.dependencies.sink();
    if (this.state.outputVolumeSupported) audio.volume = outputVolume;
    this.update({ outputVolume: audio.volume });
  };
  levels = () => {
    const stream = this.audio?.srcObject;
    if (!this.outputSource && this.context && stream instanceof MediaStream) {
      this.outputSource = this.context.createMediaStreamSource(stream);
      this.outputMeter = this.context.createAnalyser();
      this.outputMeter.fftSize = 256;
      this.outputSource.connect(this.outputMeter);
    }
    const level = (meter: AnalyserNode | null) => {
      if (!meter) return 0;
      const data = new Uint8Array(meter.fftSize);
      meter.getByteTimeDomainData(data);
      return Math.min(
        1,
        Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length),
      );
    };
    return {
      input: level(this.inputMeter),
      output: this.audio?.muted ? 0 : level(this.outputMeter) * this.state.outputVolume,
    };
  };
  release = () => {
    ++this.operation;
    ++this.selection;
    ++this.outputSelection;
    this.source?.disconnect();
    this.outputSource?.disconnect();
    this.unwatchCapture?.();
    this.unwatchCapture = null;
    stop(this.capture);
    stop(this.destination?.stream ?? null);
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => {});
    }
    this.context = null;
    this.capture = null;
    this.source = null;
    this.gain = null;
    this.destination = null;
    this.inputMeter = null;
    this.outputMeter = null;
    this.outputSource = null;
    this.audio = null;
    this.update({ inputIssue: null });
  };
}
