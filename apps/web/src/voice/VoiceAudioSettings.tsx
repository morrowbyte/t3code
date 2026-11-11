import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { BrowserVoiceAudio } from "./BrowserVoiceAudio";

export function VoiceAudioSettings({
  audio,
  muted = false,
}: {
  readonly audio: BrowserVoiceAudio;
  readonly muted?: boolean;
}) {
  const state = useSyncExternalStore(audio.subscribe, audio.getSnapshot);
  const microphoneId = useId();
  const speakerId = useId();
  const [levels, setLevels] = useState({ input: 0, output: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Watches browser device changes only while the audio controls are open.
  useEffect(audio.observeDevices, [audio]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Samples the live audio graph only while its meters are visible.
  useEffect(() => {
    const timer = window.setInterval(() => setLevels(audio.levels()), 200);
    return () => window.clearInterval(timer);
  }, [audio]);
  const microphones = state.devices.filter(
    (device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default",
  );
  const speakers = state.devices.filter(
    (device) => device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default",
  );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Audio devices</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh audio devices"
          onClick={() => void audio.refresh()}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <div className="space-y-1.5">
        <span id={microphoneId} className="text-xs font-medium">
          Microphone
        </span>
        <Select
          value={state.microphone}
          disabled={state.busy}
          onValueChange={(value) => {
            if (value !== null) void audio.selectMicrophone(value);
          }}
        >
          <SelectTrigger size="sm" aria-labelledby={microphoneId}>
            <SelectValue>
              {state.microphone
                ? microphones.find((device) => device.deviceId === state.microphone)?.label ||
                  "Microphone unavailable"
                : "System default"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">System default</SelectItem>
            {microphones.map((device, index) => (
              <SelectItem key={device.deviceId} value={device.deviceId}>
                {device.label || `Microphone ${index + 1}`}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {state.permission !== "granted" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={state.busy}
          onClick={() => void audio.requestPermission()}
        >
          {state.busy ? "Requesting access…" : "Allow microphone"}
        </Button>
      ) : null}
      <label className="grid gap-1.5 text-xs">
        <span className="flex justify-between gap-2">
          <span>Microphone level</span>
          <span className="tabular-nums">{Math.round(state.inputGain * 100)}%</span>
        </span>
        <input
          className="w-full accent-primary"
          type="range"
          min="0"
          max="200"
          step="5"
          value={Math.round(state.inputGain * 100)}
          onChange={(event) => audio.setInputGain(Number(event.target.value) / 100)}
        />
      </label>
      <meter
        className="block h-2 w-full"
        min="0"
        max="1"
        value={muted ? 0 : levels.input}
        aria-label="Microphone signal"
      />
      {state.inputIssue ? (
        <p role="alert" className="text-xs text-destructive">
          {state.inputIssue === "suspended"
            ? "Audio paused by the browser."
            : state.inputIssue === "ended"
              ? "Microphone disconnected. Choose another device."
              : "Microphone unavailable at the system level. Check system audio settings."}
        </p>
      ) : null}
      {state.inputIssue === "suspended" ? (
        <Button size="sm" variant="outline" onClick={() => void audio.resume()}>
          Resume audio
        </Button>
      ) : null}
      <div className="space-y-1.5">
        <span id={speakerId} className="text-xs font-medium">
          Speaker
        </span>
        {state.outputSelectionSupported ? (
          <Select
            value={state.speaker}
            onValueChange={(value) => {
              if (value !== null) void audio.selectSpeaker(value);
            }}
          >
            <SelectTrigger size="sm" aria-labelledby={speakerId}>
              <SelectValue>
                {state.speaker
                  ? speakers.find((device) => device.deviceId === state.speaker)?.label ||
                    "Speaker unavailable"
                  : "System default"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">System default</SelectItem>
              {speakers.map((device, index) => (
                <SelectItem key={device.deviceId} value={device.deviceId}>
                  {device.label || `Speaker ${index + 1}`}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">
            Use system audio settings to change the speaker in this browser.
          </p>
        )}
      </div>
      <label className="grid gap-1.5 text-xs">
        <span className="flex justify-between gap-2">
          <span>Voice volume</span>
          <span className="tabular-nums">{Math.round(state.outputVolume * 100)}%</span>
        </span>
        <input
          className="w-full accent-primary"
          type="range"
          min="0"
          max="100"
          step="5"
          value={Math.round(state.outputVolume * 100)}
          onChange={(event) => audio.setOutputVolume(Number(event.target.value) / 100)}
        />
      </label>
      <meter
        className="block h-2 w-full"
        min="0"
        max="1"
        value={levels.output}
        aria-label="Voice output signal"
      />
      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
