import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { useComposerTypingGuard } from "../components/chat/useComposerTypingGuard";
import { TooltipProvider } from "../components/ui/tooltip";
import { VoiceDictationControl } from "./VoiceDictationControl";
import { PendingAnswerDictationControl } from "./PendingAnswerDictationControl";
import { EnvironmentId } from "@t3tools/contracts";

function syntheticCapture() {
  const mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const originalRecorder = globalThis.MediaRecorder;
  const trackStop = vi.fn();
  const recorders: SyntheticRecorder[] = [];
  class SyntheticRecorder {
    state: RecordingState = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    chunk(text: string) {
      expect(this.state).toBe("recording");
      this.ondataavailable?.({ data: new Blob([text]) });
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  }
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }] }) },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: SyntheticRecorder,
  });
  return {
    trackStop,
    recorder: () => recorders.at(-1)!,
    [Symbol.dispose]() {
      if (mediaDevices) Object.defineProperty(navigator, "mediaDevices", mediaDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      globalThis.MediaRecorder = originalRecorder;
    },
  };
}

it("dictates into the pending answer while preserving its text and requiring explicit submission", async () => {
  using capture = syntheticCapture();
  const answer = vi.fn();
  await using screen = await render(
    <TooltipProvider>
      <PendingAnswerDictationControl
        environmentId={EnvironmentId.make("question-dictation")}
        scope="pending-answer-insertion"
        requestId="request"
        questionId="question"
        answer="Schon erledigt."
        onChangeAnswer={answer}
        transcribe={async () => "Du kannst weiterarbeiten."}
      />
    </TooltipProvider>,
  );
  await screen.getByRole("button", { name: "Record voice message", exact: true }).click();
  await act(() => capture.recorder().chunk("synthetic question answer"));
  await expect
    .element(screen.getByRole("button", { name: "Transcribe and send recording", exact: true }))
    .toBeDisabled();
  await screen.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect
    .poll(() => answer.mock.calls)
    .toEqual([["Schon erledigt. Du kannst weiterarbeiten."]]);
  expect(capture.trackStop).toHaveBeenCalledOnce();
});

it("does not insert a late transcript into a different question", async () => {
  using capture = syntheticCapture();
  let finish!: (text: string) => void;
  const transcribe = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const answer = vi.fn();
  const control = (questionId: string) => (
    <TooltipProvider>
      <PendingAnswerDictationControl
        environmentId={EnvironmentId.make("question-dictation")}
        scope="pending-answer-race"
        requestId="request"
        questionId={questionId}
        answer=""
        onChangeAnswer={answer}
        transcribe={transcribe}
      />
    </TooltipProvider>
  );
  await using screen = await render(control("first"));
  await screen.getByRole("button", { name: "Record voice message", exact: true }).click();
  await act(() => capture.recorder().chunk("first question audio"));
  await screen.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect.poll(() => transcribe.mock.calls.length).toBe(1);
  await screen.rerender(control("second"));
  await act(() => finish("Antwort auf die erste Frage."));
  expect(answer).not.toHaveBeenCalled();
  await expect
    .element(screen.getByRole("button", { name: "Record voice message", exact: true }))
    .toBeVisible();
});

it("retains audio and original ASR across a new question and a failed send before releasing it", async () => {
  using capture = syntheticCapture();
  const originalASR = "Vor der Rückfrage. Nach der Rückfrage: alles erhalten.";
  const receivedASR: string[] = [];
  const send = vi.fn(async (_text: string) => false);
  const insert = vi.fn(() => true);
  const transcribe = vi.fn(async (audio: Blob) => {
    expect(await audio.text()).toBe("before-questionafter-question");
    receivedASR.push(originalASR);
    return originalASR;
  });
  function Composer({ requests }: { requests: string[] }) {
    const guard = useComposerTypingGuard("question-during-recording", requests);
    return requests.some((id) => !guard.heldRequestIds.has(id)) ? (
      <p>Pending question</p>
    ) : (
      <VoiceDictationControl
        targetKey="question-during-recording"
        currentTargetKey={() => "question-during-recording"}
        transcribe={transcribe}
        onTranscript={insert}
        onDraftActiveChange={guard.onVoiceDraftActiveChange}
        onSend={async (_key, text) => {
          const accepted = await send(text);
          if (accepted) guard.onSend();
          return accepted;
        }}
      />
    );
  }
  await using screen = await render(
    <TooltipProvider>
      <Composer requests={[]} />
    </TooltipProvider>,
  );
  await screen.getByRole("button", { name: "Record voice message", exact: true }).click();
  await act(() => capture.recorder().chunk("before-question"));
  await screen.rerender(
    <TooltipProvider>
      <Composer requests={["question"]} />
    </TooltipProvider>,
  );
  expect(capture.recorder().state).toBe("recording");
  expect(capture.trackStop).not.toHaveBeenCalled();
  await expect
    .element(screen.getByRole("button", { name: "Stop recording", exact: true }))
    .toBeVisible();
  await act(() => capture.recorder().chunk("after-question"));
  await screen.getByRole("button", { name: "Transcribe and send recording", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  expect(capture.trackStop).toHaveBeenCalledOnce();
  expect(insert).toHaveBeenCalledExactlyOnceWith(originalASR, "question-during-recording");
  expect(send).toHaveBeenCalledExactlyOnceWith(originalASR);
  send.mockResolvedValueOnce(true);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.element(screen.getByText("Pending question")).toBeVisible();
  expect(transcribe).toHaveBeenCalledOnce();
  expect(receivedASR).toEqual([originalASR]);
  expect(send.mock.calls.map(([text]) => text)).toEqual([originalASR, originalASR]);
});
