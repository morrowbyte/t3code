import { acquireMicrophoneOwnership } from "@t3tools/client-runtime/live-voice";
import { expect, it, vi } from "vite-plus/test";
import { stubGlobal } from "../../test/render";
import { createBrowserPcmCapture } from "./browserPcmCapture";

function expectMicrophoneOwned() {
  const competing = acquireMicrophoneOwnership();
  try {
    expect(competing).toBeNull();
  } finally {
    competing?.();
  }
}

function expectMicrophoneAvailable() {
  const release = acquireMicrophoneOwnership();
  try {
    expect(release).not.toBeNull();
  } finally {
    release?.();
  }
}

it.each(["granted", "denied"] as const)(
  "cancels an unanswered permission prompt and keeps ownership until it is %s",
  async (outcome) => {
    let grantPermission!: (media: MediaStream) => void;
    let denyPermission!: (error: Error) => void;
    const permission = new Promise<MediaStream>((resolve, reject) => {
      grantPermission = resolve;
      denyPermission = reject;
    });
    using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
    const capture = createBrowserPcmCapture(
      { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
      async () => ({ locale: "en", transcribe: async () => "" }),
    );
    const abort = new AbortController();
    await capture.transcriber.prepare({ signal: abort.signal });
    const rejected = vi.fn();
    const preparing = capture.recorder.prepareToRecordAsync(abort.signal).catch(rejected);
    const stop = vi.fn();
    try {
      expect(microphone).toHaveBeenCalledOnce();
      expectMicrophoneOwned();
      abort.abort();
      await preparing;
      expect(rejected).toHaveBeenCalledWith(abort.signal.reason);
      capture.cancelRecording();
      expectMicrophoneOwned();
    } finally {
      abort.abort();
      if (outcome === "granted")
        grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
      else denyPermission(new DOMException("Permission denied", "NotAllowedError"));
      await permission.catch(() => undefined);
      await preparing;
      capture.cancelRecording();
    }
    expect(stop).toHaveBeenCalledTimes(outcome === "granted" ? 1 : 0);
    expectMicrophoneAvailable();
    const nextOwner = acquireMicrophoneOwnership();
    try {
      expect(nextOwner).not.toBeNull();
      capture.cancelRecording();
      expectMicrophoneOwned();
    } finally {
      nextOwner?.();
    }
  },
);

it("does not request a microphone already owned by another voice source", async () => {
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  const abort = new AbortController();
  await capture.transcriber.prepare({ signal: abort.signal });
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockRejectedValue(new Error("A competing capture must not request permission."));
  const existingOwner = acquireMicrophoneOwnership();
  try {
    expect(existingOwner).not.toBeNull();
    await expect(capture.recorder.prepareToRecordAsync(abort.signal)).rejects.toThrow(
      "The microphone is already in use.",
    );
    expect(microphone).not.toHaveBeenCalled();
    capture.cancelRecording();
    expectMicrophoneOwned();
  } finally {
    capture.cancelRecording();
    existingOwner?.();
  }
});

it.each([
  "stop",
  "cancel",
  "processor error",
  "disconnect",
  "initialization error",
  "pending worklet",
  "pending resume",
] as const)(
  "releases a captured microphone on %s and ignores the old capture's callbacks",
  async (end) => {
    let finishInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    let startInitialization!: () => void;
    const initializationStarted = new Promise<void>((resolve) => {
      startInitialization = resolve;
    });
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    const media = { getTracks: () => [track] } as unknown as MediaStream;
    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      close() {},
      postMessage(message: string): void {
        if (message === "stop") port.onmessage?.(new MessageEvent("message", { data: "stopped" }));
      },
    };
    const node = {
      port,
      onprocessorerror: null as (() => void) | null,
      connect() {},
      disconnect() {},
    };
    using _context = stubGlobal(
      "AudioContext",
      class {
        destination = {};
        audioWorklet = {
          addModule: async () => {
            if (end === "initialization error") throw new Error("Worklet unavailable");
            if (end === "pending worklet") {
              startInitialization();
              await initialization;
            }
          },
        };
        createMediaStreamSource() {
          return { connect() {} };
        }
        async resume() {
          if (end === "pending resume") {
            startInitialization();
            await initialization;
          }
        }
        async close() {}
      },
    );
    using _worklet = stubGlobal("AudioWorkletNode", function AudioWorkletNode() {
      return node;
    });
    using _microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(media);
    const errors: string[] = [];
    const capture = createBrowserPcmCapture(
      {
        getMicrophoneId: () => "",
        onLevel: vi.fn(),
        onDurationLimit: vi.fn(),
        onError: (message) => errors.push(message),
      },
      async () => ({ locale: "en", transcribe: async () => "" }),
    );
    const abort = new AbortController();
    try {
      await capture.transcriber.prepare({ signal: abort.signal });
      const preparing = capture.recorder.prepareToRecordAsync(abort.signal);
      if (end === "initialization error") {
        await expect(preparing).rejects.toThrow("Worklet unavailable");
      } else if (end === "pending worklet" || end === "pending resume") {
        const result = preparing.catch((error: unknown) => error);
        await initializationStarted;
        if (end === "pending resume") capture.cancelRecording();
        else abort.abort();
        try {
          expectMicrophoneAvailable();
        } finally {
          finishInitialization();
          expect(await result).toBeInstanceOf(DOMException);
        }
      } else {
        await preparing;
        capture.recorder.record({ forDuration: 60 });
        expectMicrophoneOwned();
        if (end === "stop") await capture.recorder.stop();
        else if (end === "cancel") capture.cancelRecording();
        else if (end === "processor error") node.onprocessorerror?.();
        else track.dispatchEvent(new Event("ended"));
      }
      expect(track.stop).toHaveBeenCalledOnce();
      expectMicrophoneAvailable();
      const nextOwner = acquireMicrophoneOwnership();
      try {
        expect(nextOwner).not.toBeNull();
        const priorErrors = errors.length;
        node.onprocessorerror?.();
        track.dispatchEvent(new Event("ended"));
        capture.cancelRecording();
        expect(errors).toHaveLength(priorErrors);
        expectMicrophoneOwned();
      } finally {
        nextOwner?.();
      }
    } finally {
      finishInitialization();
      abort.abort();
      capture.cancelRecording();
    }
  },
);
