import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../test/render";
import {
  useVoiceDictation,
  VoiceDictationServiceError,
  type VoiceDictationTranscriber,
} from "./useVoiceDictation";
import { acquireMicrophoneOwnership } from "@t3tools/client-runtime/live-voice";
import { readRecordingDraft, writeRecordingDraft } from "./recordingDraftStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";

function setup() {
  using resources = new DisposableStack();
  const onTranscript = vi.fn<(transcript: string) => void>();
  const onSend = vi.fn(async (_transcript: string) => true);
  const hasTranscript = vi.fn((_transcript: string) => true);
  const trackStop = vi.fn();
  const revokedUrls: string[] = [];
  const targets = new Set<string>();

  class FakeMediaRecorder {
    static instance: FakeMediaRecorder | null = null;
    state: RecordingState = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly stream: MediaStream) {
      FakeMediaRecorder.instance = this;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state !== "recording") return;
      this.ondataavailable?.({ data: new Blob(["audio"]) } as BlobEvent);
      this.state = "inactive";
      this.onstop?.();
    }
  }

  resources.use(stubGlobal("MediaRecorder", FakeMediaRecorder));
  const mediaDevices: Pick<MediaDevices, "getUserMedia"> = {
    getUserMedia: vi.fn(
      async () => ({ getTracks: () => [{ stop: trackStop }] }) as unknown as MediaStream,
    ),
  };
  resources.use(
    vi.spyOn(navigator, "mediaDevices", "get").mockReturnValue(mediaDevices as MediaDevices),
  );
  // These cases exercise the in-memory draft lifecycle, as in the original Node suite.
  resources.use(stubGlobal("indexedDB", undefined));
  resources.use(vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-review"));
  resources.use(
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revokedUrls.push(url);
    }),
  );
  resources.defer(() => {
    for (const target of targets) writeRecordingDraft(target, null);
  });
  const cleanup = resources.move();
  let latest: ReturnType<typeof useVoiceDictation> | null = null;
  return {
    get latest() {
      return latest;
    },
    publish(value: ReturnType<typeof useVoiceDictation>, targetKey?: string) {
      latest = value;
      if (targetKey) targets.add(targetKey);
    },
    MediaRecorder: FakeMediaRecorder,
    onTranscript,
    onSend,
    hasTranscript,
    trackStop,
    revokedUrls,
    targets,
    setGetUserMedia: (getUserMedia: MediaDevices["getUserMedia"]) => {
      mediaDevices.getUserMedia = getUserMedia;
    },
    releaseOnDispose: (release: (() => void) | null) => cleanup.defer(() => release?.()),
    [Symbol.dispose]: () => cleanup.dispose(),
  };
}

function Probe({
  test,
  transcribe,
  targetKey,
}: {
  test: ReturnType<typeof setup>;
  transcribe: VoiceDictationTranscriber | null;
  targetKey?: string | undefined;
}) {
  const value = useVoiceDictation({
    transcribe,
    onTranscript: test.onTranscript,
    onSend: test.onSend,
    hasTranscript: test.hasTranscript,
    ...(targetKey ? { targetKey } : {}),
  });
  useLayoutEffect(() => {
    test.publish(value, targetKey);
  }, [test, value, targetKey]);
  return null;
}

function renderProbe(
  test: ReturnType<typeof setup>,
  transcribe: VoiceDictationTranscriber | null,
  targetKey?: string,
) {
  // The hook has no routing dependency; keep its synthetic lifecycle independent of navigation.
  return render(<Probe test={test} transcribe={transcribe} targetKey={targetKey} />, {
    router: false,
  });
}

async function startAndStop(test: ReturnType<typeof setup>) {
  await act(async () => test.latest?.start());
  expect(test.latest?.state.phase).toBe("recording");
  await act(() => test.latest?.stop("review"));
  expect(test.latest?.state.phase).toBe("review");
}

describe("useVoiceDictation", () => {
  it("adds speech transcription provenance only after the successful synthetic transcript insertion", async () => {
    using test = setup();
    const target = DraftId.make("speech-synthetic-success");
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "Bitte prüfe");
    test.onTranscript.mockImplementation((text) => {
      store.appendSpeechTranscript(target, text);
    });
    await using _screen = await renderProbe(
      test,
      vi.fn(async () => "Plain37"),
      "speech-synthetic-success",
    );
    await act(async () => test.latest?.start());
    expect(store.getComposerDraft(target)?.speechTranscription).toBeUndefined();
    await act(async () => test.latest?.stop());
    expect(store.getComposerDraft(target)?.prompt).toBe("Bitte prüfe\nPlain37");
    expect(store.getComposerDraft(target)?.speechTranscription?.ranges).toEqual([
      { start: 12, end: 19 },
    ]);
    store.clearComposerContent(target);
  });

  it("does not add speech transcription provenance after cancellation or a late synthetic result", async () => {
    using test = setup();
    const target = DraftId.make("speech-synthetic-cancel");
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "Getippter Text");
    test.onTranscript.mockImplementation((text) => {
      store.appendSpeechTranscript(target, text);
    });
    let resolveTranscript!: (text: string) => void;
    await using _screen = await renderProbe(
      test,
      () =>
        new Promise<string>((resolve) => {
          resolveTranscript = resolve;
        }),
      "speech-synthetic-cancel",
    );
    await startAndStop(test);
    let pending: Promise<void> | undefined;
    await act(() => {
      pending = test.latest?.transcribe();
    });
    await act(() => test.latest?.cancel());
    await act(async () => {
      resolveTranscript("Plain37");
      await pending;
    });
    expect(store.getComposerDraft(target)?.prompt).toBe("Getippter Text");
    expect(store.getComposerDraft(target)?.speechTranscription).toBeUndefined();
    store.clearComposerContent(target);
  });
  it("Stop transcribes directly into the prompt without sending", async () => {
    using test = setup();
    const transcribe = vi.fn(async () => "  stopped words  ");
    await using _screen = await renderProbe(test, transcribe, "voice-stop:auto");
    await act(async () => test.latest?.start());
    await act(async () => test.latest?.stop());
    expect(transcribe).toHaveBeenCalledOnce();
    expect(test.onTranscript).toHaveBeenCalledWith("stopped words");
    expect(test.onSend).not.toHaveBeenCalled();
    expect(test.latest?.state.phase).toBe("idle");
    expect(await readRecordingDraft("voice-stop:auto")).toBeNull();
  });

  it("Send retains audio until the message is accepted", async () => {
    using test = setup();
    let accept!: (accepted: boolean) => void;
    test.onSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    await using _screen = await renderProbe(test, async () => "send words", "voice-send:pending");
    await act(async () => test.latest?.start());
    await act(async () => test.latest?.stop("send"));
    expect(test.onTranscript).toHaveBeenCalledWith("send words");
    expect(test.latest?.state.phase).toBe("transcribing");
    expect((await readRecordingDraft("voice-send:pending"))?.audio.size).toBeGreaterThan(0);
    await act(async () => accept(true));
    expect(test.latest?.state.phase).toBe("idle");
    expect(await readRecordingDraft("voice-send:pending")).toBeNull();
  });

  it("retries a failed Send after remount without inserting or transcribing twice", async () => {
    using test = setup();
    const targetKey = "voice-send:retry";
    const transcribe = vi.fn(async () => "editable words");
    test.onSend.mockResolvedValueOnce(false);
    await using _screen = await renderProbe(test, transcribe, targetKey);
    await act(async () => test.latest?.start());
    await act(async () => test.latest?.stop("send"));
    expect(test.latest?.state.phase).toBe("error");
    expect((await readRecordingDraft(targetKey))?.transcript).toBe("editable words");
    await _screen.unmount();
    await using _remountedScreen = await renderProbe(test, transcribe, targetKey);
    await act(async () => test.latest?.transcribe("send"));
    expect(transcribe).toHaveBeenCalledOnce();
    expect(test.onTranscript).toHaveBeenCalledOnce();
    expect(test.onSend).toHaveBeenCalledTimes(2);
    expect(await readRecordingDraft(targetKey)).toBeNull();
  });

  it("shares a pending Send across remount and removes audio after acceptance", async () => {
    using test = setup();
    let accept!: (accepted: boolean) => void;
    test.onSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const targetKey = "voice-send:remount-pending";
    const transcribe = vi.fn(async () => "send once");
    await using _screen = await renderProbe(test, transcribe, targetKey);
    await act(async () => test.latest?.start());
    await act(async () => test.latest?.stop("send"));
    await _screen.unmount();
    await using _remountedScreen = await renderProbe(test, transcribe, targetKey);
    let retry: Promise<void> | undefined;
    await act(() => {
      retry = test.latest?.transcribe("send");
    });
    expect(test.onSend).toHaveBeenCalledOnce();
    await act(async () => {
      accept(true);
      await retry;
    });
    expect(test.onTranscript).toHaveBeenCalledOnce();
    expect(await readRecordingDraft(targetKey)).toBeNull();
    expect(test.latest?.state.phase).toBe("idle");
  });

  it("removes the remounted recording when the original Send succeeds without a retry", async () => {
    using test = setup();
    let accept!: (accepted: boolean) => void;
    test.onSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const targetKey = "voice-send:late-admission";
    const transcribe = vi.fn(async () => "already delivered");
    await using _screen = await renderProbe(test, transcribe, targetKey);
    await act(async () => test.latest?.start());
    await act(async () => test.latest?.stop("send"));
    await _screen.unmount();
    await using _remountedScreen = await renderProbe(test, transcribe, targetKey);
    expect(test.latest?.state.phase).toBe("review");
    await act(async () => accept(true));
    expect(test.latest?.state.phase).toBe("idle");
    await act(async () => test.latest?.transcribe("send"));
    expect(test.onSend).toHaveBeenCalledOnce();
    expect(await readRecordingDraft(targetKey)).toBeNull();
  });

  it("does not send a replacement prompt as a recording retry", async () => {
    using test = setup();
    const targetKey = "voice-send:replacement-prompt";
    await using _screen = await renderProbe(test, async () => "original speech", targetKey);
    test.onSend.mockResolvedValueOnce(false);
    await act(async () => test.latest?.start());
    await act(async () => test.latest?.stop("send"));
    test.hasTranscript.mockReturnValue(false);
    await act(async () => test.latest?.transcribe("send"));
    expect(test.onSend).toHaveBeenCalledOnce();
    expect(test.onTranscript).toHaveBeenCalledOnce();
    expect(test.latest?.state).toMatchObject({
      phase: "error",
      message: expect.stringContaining("Insert text"),
    });
    expect((await readRecordingDraft(targetKey))?.audio.size).toBeGreaterThan(0);
    await act(async () => test.latest?.transcribe());
    expect(test.onTranscript).toHaveBeenCalledTimes(2);
    expect(test.latest?.state.phase).toBe("idle");
  });

  it("preserves an active recording during composer remount without delivering it", async () => {
    using test = setup();
    const targetKey = "voice-capture:remount";
    const transcribe = vi.fn(async () => "unused");
    await using _screen = await renderProbe(test, transcribe, targetKey);
    await act(async () => test.latest?.start());
    await _screen.unmount();
    expect((await readRecordingDraft(targetKey))?.audio.size).toBeGreaterThan(0);
    expect(test.trackStop).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
    await using _remountedScreen = await renderProbe(test, transcribe, targetKey);
    expect(test.latest?.state.phase).toBe("review");
    await act(() => test.latest?.cancel());
  });

  it("restores a failed recording after Settings navigation and retries after configuration", async () => {
    using test = setup();
    const targetKey = "voice-recovery:environment:thread";
    await using _screen = await renderProbe(
      test,
      async () => {
        throw VoiceDictationServiceError.new("Provider unavailable");
      },
      targetKey,
    );
    await startAndStop(test);
    await act(async () => test.latest?.transcribe());
    expect(test.latest?.state.phase).toBe("error");
    await _screen.unmount();
    expect((await readRecordingDraft(targetKey))?.audio.size).toBeGreaterThan(0);
    const retry = vi.fn(async () => "recovered words");
    await using _remountedScreen = await renderProbe(test, retry, targetKey);
    expect(test.latest?.state).toMatchObject({ phase: "error", audioUrl: "blob:voice-review" });
    await act(async () => test.latest?.transcribe());
    expect(test.onTranscript).toHaveBeenCalledWith("recovered words");
    expect(await readRecordingDraft(targetKey)).toBeNull();
  });

  it("keeps recordings on their original draft across target switches", async () => {
    using test = setup();
    const transcribe = vi.fn(async () => "words");
    await using _screen = await renderProbe(test, transcribe, "voice-switch:environment-a:thread");
    await startAndStop(test);
    await _screen.rerender(
      <Probe test={test} transcribe={transcribe} targetKey="voice-switch:environment-b:thread" />,
    );
    expect(test.latest?.state.phase).toBe("idle");
    await _screen.rerender(
      <Probe test={test} transcribe={transcribe} targetKey="voice-switch:environment-a:thread" />,
    );
    expect(test.latest?.state.phase).toBe("review");
    await act(() => test.latest?.cancel());
    expect(await readRecordingDraft("voice-switch:environment-a:thread")).toBeNull();
  });

  it("keeps the audio when transcript insertion fails", async () => {
    using test = setup();
    const key = "voice-insertion:environment:thread";
    test.onTranscript.mockImplementationOnce(() => {
      throw new Error("Draft changed");
    });
    await using _screen = await renderProbe(test, async () => "words", key);
    await startAndStop(test);
    await act(async () => test.latest?.transcribe());
    expect((await readRecordingDraft(key))?.audio.size).toBeGreaterThan(0);
    await act(async () => test.latest?.transcribe());
    expect(await readRecordingDraft(key)).toBeNull();
  });
  it("keeps the recording for playback review, then inserts only after explicit transcription", async () => {
    using test = setup();
    const transcribe = vi.fn(async () => "  recognized words  ");
    await using _screen = await renderProbe(test, transcribe);
    await startAndStop(test);

    expect(test.latest?.state).toEqual({
      phase: "review",
      audioUrl: "blob:voice-review",
      audioType: "audio/webm",
    });
    expect(test.trackStop).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
    expect(test.onTranscript).not.toHaveBeenCalled();
    const liveCanStartDuringReview = acquireMicrophoneOwnership();
    test.releaseOnDispose(liveCanStartDuringReview);
    expect(liveCanStartDuringReview).not.toBeNull();
    liveCanStartDuringReview?.();

    await act(async () => test.latest?.transcribe());
    expect(transcribe).toHaveBeenCalledOnce();
    expect(test.onTranscript).toHaveBeenCalledWith("recognized words");
    expect(test.latest?.state.phase).toBe("idle");
    expect(test.revokedUrls).toEqual(["blob:voice-review"]);
  });

  it("retains review audio after failure and permits retry", async () => {
    using test = setup();
    const transcribe = vi
      .fn<VoiceDictationTranscriber>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("retry worked");
    await using _screen = await renderProbe(test, transcribe);
    await startAndStop(test);

    await act(async () => test.latest?.transcribe());
    expect(test.latest?.state).toEqual({
      phase: "error",
      message: "Transcription failed. Your recording is still available to retry.",
      audioUrl: "blob:voice-review",
    });
    expect(test.revokedUrls).toEqual([]);

    await act(async () => test.latest?.transcribe());
    expect(test.onTranscript).toHaveBeenCalledWith("retry worked");
    expect(test.revokedUrls).toEqual(["blob:voice-review"]);
  });

  it("shows a validated provider failure message and keeps the recording available to retry", async () => {
    using test = setup();
    const transcribe = vi
      .fn<VoiceDictationTranscriber>()
      .mockRejectedValue(
        VoiceDictationServiceError.new("The transcription provider denied this request."),
      );
    await using _screen = await renderProbe(test, transcribe);
    await startAndStop(test);

    await act(async () => test.latest?.transcribe());
    expect(test.latest?.state).toEqual({
      phase: "error",
      message: "The transcription provider denied this request.",
      audioUrl: "blob:voice-review",
    });
    expect(test.revokedUrls).toEqual([]);
  });

  it("cancels in-flight transcription and ignores a late result", async () => {
    using test = setup();
    let finish!: (value: string) => void;
    const transcribe = vi.fn<VoiceDictationTranscriber>(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await using _screen = await renderProbe(test, transcribe);
    await startAndStop(test);

    let transcription: Promise<void> | undefined;
    await act(() => {
      transcription = test.latest?.transcribe();
    });
    const signal = transcribe.mock.calls[0]?.[1].signal;
    await act(() => test.latest?.cancel());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish("too late");
      await transcription;
    });
    expect(test.onTranscript).not.toHaveBeenCalled();
    expect(test.latest?.state.phase).toBe("idle");
    expect(test.revokedUrls).toEqual(["blob:voice-review"]);
  });

  it("stops tracks if permission resolves after cancellation", async () => {
    using test = setup();
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    test.setGetUserMedia(getUserMedia);
    await using _screen = await renderProbe(test, async () => "unused");
    let start: Promise<void> | undefined;
    await act(() => {
      start = test.latest?.start();
    });
    await act(() => test.latest?.cancel());
    const lateStop = vi.fn();
    await act(async () => {
      grant({ getTracks: () => [{ stop: lateStop }] } as unknown as MediaStream);
      await start;
    });
    expect(lateStop).toHaveBeenCalledOnce();
    expect(test.latest?.state.phase).toBe("idle");
    expect(test.MediaRecorder.instance).toBeNull();
  });

  it("does not open a second stream while microphone permission is pending", async () => {
    using test = setup();
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    test.setGetUserMedia(getUserMedia);
    await using _screen = await renderProbe(test, async () => "unused");
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    await act(() => {
      first = test.latest?.start();
      second = test.latest?.start();
    });
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => {
      grant({ getTracks: () => [{ stop: test.trackStop }] } as unknown as MediaStream);
      await Promise.all([first, second]);
    });
    expect(test.MediaRecorder.instance).not.toBeNull();
    expect(test.latest?.state.phase).toBe("recording");
  });

  it("does not request another stream after cancellation until the pending permission request settles", async () => {
    using test = setup();
    let grantFirst!: (stream: MediaStream) => void;
    let grantSecond!: (stream: MediaStream) => void;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (grantFirst = resolve)))
      .mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (grantSecond = resolve)));
    test.setGetUserMedia(getUserMedia);
    await using _screen = await renderProbe(test, async () => "unused");

    let first: Promise<void> | undefined;
    await act(() => {
      first = test.latest?.start();
    });
    await act(() => test.latest?.cancel());
    await act(async () => test.latest?.start());
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(test.latest?.state).toMatchObject({ phase: "error" });

    const lateTrackStop = vi.fn();
    await act(async () => {
      grantFirst({ getTracks: () => [{ stop: lateTrackStop }] } as unknown as MediaStream);
      await first;
    });
    expect(lateTrackStop).toHaveBeenCalledOnce();

    let second: Promise<void> | undefined;
    await act(() => {
      second = test.latest?.start();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await act(async () => {
      grantSecond({ getTracks: () => [{ stop: test.trackStop }] } as unknown as MediaStream);
      await second;
    });
    expect(test.latest?.state.phase).toBe("recording");
    await act(() => test.latest?.cancel());
  });

  it("does not start dictation while Live owns the renderer microphone", async () => {
    using test = setup();
    const releaseLive = acquireMicrophoneOwnership();
    test.releaseOnDispose(releaseLive);
    expect(releaseLive).not.toBeNull();
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    await using _screen = await renderProbe(test, async () => "unused");

    await act(async () => test.latest?.start());

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(test.latest?.state).toEqual({
      phase: "error",
      message: "Another microphone session is active. End it before recording.",
    });
    const stillOwned = acquireMicrophoneOwnership();
    test.releaseOnDispose(stillOwned);
    expect(stillOwned).toBeNull();
    stillOwned?.();
    releaseLive?.();
    await act(async () => test.latest?.start());
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(test.latest?.state.phase).toBe("recording");
    await act(() => test.latest?.cancel());
  });

  it("ignores a rejected permission request after cancellation", async () => {
    using test = setup();
    let reject!: (error: Error) => void;
    test.setGetUserMedia(
      vi.fn(
        () =>
          new Promise<MediaStream>((_resolve, fail) => {
            reject = fail;
          }),
      ),
    );
    await using _screen = await renderProbe(test, async () => "unused");
    let start: Promise<void> | undefined;
    await act(() => {
      start = test.latest?.start();
    });
    await act(() => test.latest?.cancel());
    await act(async () => {
      reject(new Error("permission denied"));
      await start;
    });
    expect(test.latest?.state.phase).toBe("idle");
    const releaseLive = acquireMicrophoneOwnership();
    test.releaseOnDispose(releaseLive);
    expect(releaseLive).not.toBeNull();
    releaseLive?.();
  });

  it("does not let a late stop callback from a cancelled recorder affect a new capture", async () => {
    using test = setup();
    await using _screen = await renderProbe(test, async () => "unused");
    await act(async () => test.latest?.start());
    const oldRecorder = test.MediaRecorder.instance!;
    const oldOnStop = oldRecorder.onstop!;
    const oldOnData = oldRecorder.ondataavailable!;
    await act(() => test.latest?.cancel());
    await act(async () => test.latest?.start());
    const currentRecorder = test.MediaRecorder.instance!;

    await act(() => {
      oldOnData({ data: new Blob(["stale"]) } as BlobEvent);
      oldOnStop();
    });
    expect(currentRecorder.state).toBe("recording");
    expect(test.latest?.state.phase).toBe("recording");
    await act(() => test.latest?.stop("review"));
    expect(test.latest?.state.phase).toBe("review");
  });
});
