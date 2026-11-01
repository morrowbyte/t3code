import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { AssistantCitationCommentEditor } from "~/components/chat/AssistantCitationCommentEditor";
import { ImageAnnotationEditor } from "~/components/chat/ImageAnnotationEditor";
import { CommentDictationControl } from "./CommentDictationControl";
import { useCommentDictation } from "./useCommentDictation";

const mocks = vi.hoisted(() => ({ transcribe: vi.fn<() => Promise<string>>() }));
vi.mock("./transcriptionClient", () => ({ transcribeVoiceRecording: () => mocks.transcribe }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function syntheticCapture() {
  mocks.transcribe.mockReset().mockResolvedValue("Gesprochener Kommentar.");
  const mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const recorder = globalThis.MediaRecorder;
  const trackStop = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
  class Recorder {
    state: RecordingState = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state !== "recording") return;
      this.ondataavailable?.({ data: new Blob(["synthetic comment"]) });
      this.state = "inactive";
      this.onstop?.();
    }
  }
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: Recorder,
  });
  return {
    trackStop,
    getUserMedia,
    [Symbol.dispose]() {
      if (mediaDevices) Object.defineProperty(navigator, "mediaDevices", mediaDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      globalThis.MediaRecorder = recorder;
    },
  };
}

const target = { environmentId: EnvironmentId.make("comment-env"), targetKey: "thread" };
const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("source-env"),
  threadId: ThreadId.make("source-thread"),
  messageId: MessageId.make("source-message"),
  start: 0,
  end: 5,
  text: "Quote",
  prefix: "",
  suffix: "",
  comment: "Vorhanden.",
};

it("keeps citation text editable and requires explicit saving after dictation", async () => {
  using capture = syntheticCapture();
  const save = vi.fn(() => true);
  const send = vi.fn(() => true);
  await using screen = await render(
    <AssistantCitationCommentEditor
      citation={citation}
      dictationTarget={target}
      onCancel={() => {}}
      onSubmit={save}
      onSubmitAndSend={send}
    />,
  );
  await screen.getByRole("button", { name: "Dictate comment", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await screen.getByRole("button", { name: "Finish dictation", exact: true }).click();
  const input = screen.getByRole("textbox", { name: "Comment on selected text" });
  await expect.element(input).toHaveValue("Vorhanden. Gesprochener Kommentar.");
  expect(save).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  await input.fill("Korrigierter Kommentar.");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  expect(save).toHaveBeenCalledExactlyOnceWith("Korrigierter Kommentar.");
  expect(send).not.toHaveBeenCalled();
  expect(capture.trackStop).toHaveBeenCalledOnce();
});

it("adds dictated text to the annotation message without sending the image", async () => {
  using _capture = syntheticCapture();
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const send = vi.fn(async () => false);
  await using screen = await render(
    <ImageAnnotationEditor
      src={canvas.toDataURL("image/png")}
      name="fixture.png"
      dictationTarget={target}
      renderImage={(overlay) => <div>{overlay}</div>}
      onZoom={() => {}}
      onFit={() => {}}
      onCancel={() => {}}
      onSend={send}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Message with annotation" });
  await input.fill("Bestehende Bildnotiz.");
  await screen.getByRole("button", { name: "Dictate comment", exact: true }).click();
  await screen.getByRole("button", { name: "Finish dictation", exact: true }).click();
  await expect.element(input).toHaveValue("Bestehende Bildnotiz. Gesprochener Kommentar.");
  expect(send).not.toHaveBeenCalled();
});

function CommentDraft({ targetKey = "first" }: { targetKey?: string }) {
  const [value, setValue] = useState("Existing draft");
  const dictation = useCommentDictation({ ...target, targetKey, value, onChange: setValue });
  return (
    <>
      <textarea
        aria-label="Draft"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <CommentDictationControl dictation={dictation} />
    </>
  );
}

it("cancels pending microphone permission without changing the comment", async () => {
  using capture = syntheticCapture();
  const permission = deferred<Awaited<ReturnType<typeof capture.getUserMedia>>>();
  capture.getUserMedia.mockReturnValueOnce(permission.promise);
  await using screen = await render(<CommentDraft />);
  try {
    await screen.getByRole("button", { name: "Dictate comment", exact: true }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Preparing microphone…");
    await screen.getByRole("button", { name: "Cancel dictation", exact: true }).click();
  } finally {
    // A pending permission request retains microphone ownership even after unmount.
    await act(async () => {
      permission.resolve({ getTracks: () => [{ stop: capture.trackStop }] });
      await permission.promise;
    });
  }
  expect(capture.trackStop).toHaveBeenCalledOnce();
  expect(mocks.transcribe).not.toHaveBeenCalled();
  await expect
    .element(screen.getByRole("textbox", { name: "Draft" }))
    .toHaveValue("Existing draft");
});

it.each(["cancel", "close", "target-change"] as const)(
  "rejects late transcription after %s",
  async (action) => {
    using _capture = syntheticCapture();
    const transcript = deferred<string>();
    const entered = deferred<void>();
    mocks.transcribe.mockImplementationOnce(() => {
      entered.resolve();
      return transcript.promise;
    });
    await using screen = await render(<CommentDraft />);
    await screen.getByRole("button", { name: "Dictate comment", exact: true }).click();
    await screen.getByRole("button", { name: "Finish dictation", exact: true }).click();
    await entered.promise;
    if (action === "cancel")
      await screen.getByRole("button", { name: "Cancel dictation", exact: true }).click();
    else if (action === "close") await screen.rerender(<p>Editor closed</p>);
    else await screen.rerender(<CommentDraft targetKey="second" />);
    await act(async () => {
      transcript.resolve("Late transcript");
      await transcript.promise;
    });
    if (action === "close") await screen.rerender(<CommentDraft />);
    await expect
      .element(screen.getByRole("textbox", { name: "Draft" }))
      .toHaveValue("Existing draft");
  },
);

it("preserves edits made during transcription and keeps the draft through failure and retry", async () => {
  using _capture = syntheticCapture();
  mocks.transcribe.mockRejectedValueOnce(new Error("synthetic failure"));
  await using screen = await render(<CommentDraft />);
  await screen.getByRole("button", { name: "Dictate comment", exact: true }).click();
  await screen.getByRole("button", { name: "Finish dictation", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  const input = screen.getByRole("textbox", { name: "Draft" });
  await expect.element(input).toHaveValue("Existing draft");
  const transcript = deferred<string>();
  const entered = deferred<void>();
  mocks.transcribe.mockImplementationOnce(() => {
    entered.resolve();
    return transcript.promise;
  });
  await screen.getByRole("button", { name: "Retry transcription", exact: true }).click();
  await entered.promise;
  await input.fill("Edited meanwhile");
  await act(async () => {
    transcript.resolve("inserted once");
    await transcript.promise;
  });
  await expect.element(input).toHaveValue("Edited meanwhile inserted once");
});
