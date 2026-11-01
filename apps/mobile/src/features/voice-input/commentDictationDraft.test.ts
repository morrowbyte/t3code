import type { PreparedVoiceTranscription } from "@t3tools/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";
import { createCommentDictationDraft } from "./commentDictationDraft";
import { createVoiceInputTarget, VoiceInputSession } from "./voiceInputSession";

function setup() {
  resetVoiceInputGlobalsForTests();
  const draft = createCommentDictationDraft("image-comment:session-one");
  const commit = vi.fn();
  draft.update("Existing note", commit);
  const permission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
  const prepare = vi.fn(async (): Promise<PreparedVoiceTranscription> => ({
    locale: "en-US",
    transcribe: async () => "spoken comment",
  }));
  const session = new VoiceInputSession({
    recorder: {
      uri: "file:///synthetic-comment.m4a",
      prepareToRecordAsync: async () => {},
      record: vi.fn(),
      stop: async () => {},
    },
    getTranscriber: () => ({ prepare }),
    requestPermission: permission,
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: vi.fn(),
    sampleRecording: () => null,
    publishAudioLevels: vi.fn(),
    keepAwake: () => vi.fn(),
  });
  const target = createVoiceInputTarget(
    draft.ownerKey,
    draft.read,
    draft.commit,
    { start: 13, end: 13 },
    draft.subscribe,
  );
  return {
    draft,
    commit,
    permission,
    prepare,
    session,
    target,
    [Symbol.dispose]: () => session.dispose(),
  };
}

describe("native comment dictation", () => {
  it("inserts editable speech after existing text only after finishing", async () => {
    using fixture = setup();
    await fixture.session.start(fixture.target);
    expect(fixture.commit).not.toHaveBeenCalled();
    await fixture.session.controller.stop();
    expect(fixture.commit).toHaveBeenCalledExactlyOnceWith("Existing note spoken comment");
  });

  it.each(["preparing", "recording", "transcribing"] as const)(
    "cancels a closed or replaced comment during %s without writing to either draft",
    async (phase) => {
      using fixture = setup();
      const permission = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
      const enteredPermission = Promise.withResolvers<void>();
      const transcript = Promise.withResolvers<string>();
      const enteredTranscription = Promise.withResolvers<void>();
      if (phase === "preparing") {
        fixture.permission.mockImplementationOnce(() => {
          enteredPermission.resolve();
          return permission.promise;
        });
      }
      fixture.prepare.mockResolvedValue({
        locale: "en-US",
        transcribe: () => {
          enteredTranscription.resolve();
          return transcript.promise;
        },
      });
      const starting = fixture.session.start(fixture.target);
      if (phase === "preparing") await enteredPermission.promise;
      else await starting;
      const stopping = phase === "transcribing" ? fixture.session.controller.stop() : null;
      if (stopping) await enteredTranscription.promise;
      expect(fixture.session.controller.currentState.phase).toBe(phase);
      fixture.draft.deactivate();
      fixture.session.cancel(fixture.draft.ownerKey);
      const nextDraft = createCommentDictationDraft("image-comment:session-two");
      const nextCommit = vi.fn();
      nextDraft.update("Next image", nextCommit);
      permission.resolve({ granted: true, canAskAgain: true });
      transcript.resolve("late words");
      await starting;
      await stopping;
      expect(fixture.commit).not.toHaveBeenCalled();
      expect(nextCommit).not.toHaveBeenCalled();
      expect(nextDraft.read()).toBe("Next image");
      expect(fixture.session.controller.currentState.phase).toBe("idle");
    },
  );

  it("keeps the draft through failure and rejects speech after the draft was edited", async () => {
    using fixture = setup();
    fixture.prepare.mockRejectedValueOnce(new Error("synthetic provider failure"));
    await fixture.session.start(fixture.target);
    expect(fixture.session.controller.currentState.phase).toBe("error");
    expect(fixture.draft.read()).toBe("Existing note");
    await fixture.session.retry();
    fixture.draft.update("Edited note", fixture.commit);
    await fixture.session.controller.stop();
    expect(fixture.session.controller.currentState.phase).toBe("error");
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.draft.read()).toBe("Edited note");
  });

  it("invalidates a departing target even before asynchronous cancellation settles", async () => {
    using fixture = setup();
    await fixture.session.start(fixture.target);
    fixture.draft.deactivate();
    await fixture.session.controller.stop();
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.session.controller.currentState.phase).toBe("error");
  });
});
