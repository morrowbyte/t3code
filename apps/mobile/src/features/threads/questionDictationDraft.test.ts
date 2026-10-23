import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  PreparedVoiceTranscription,
  VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";
import { createVoiceInputTarget, VoiceInputSession } from "../voice-input/voiceInputSession";
import {
  createQuestionDictationDraft,
  questionDictationBlocksSubmission,
  questionDictationOwnerKey,
} from "./questionDictationDraft";

const origin = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function setup() {
  const ownerKey = questionDictationOwnerKey(origin, "request", "question");
  const draft = createQuestionDictationDraft(ownerKey);
  const commit = vi.fn();
  draft.update("Existing answer", commit);
  const permission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
  const prepare = vi.fn(async (): Promise<PreparedVoiceTranscription> => ({
    locale: "en-US",
    transcribe: async () => "spoken answer",
  }));
  const session = new VoiceInputSession({
    recorder: {
      uri: "file:///synthetic-question.m4a",
      prepareToRecordAsync: async () => {},
      record: vi.fn(),
      stop: async () => {},
    },
    getTranscriber: () => ({ prepare }),
    requestPermission: permission,
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: vi.fn(),
    onStateChange: vi.fn(),
  });
  const target = createVoiceInputTarget(
    ownerKey,
    draft.read,
    draft.commit,
    { start: 15, end: 15 },
    draft.subscribe,
  );
  return { draft, commit, permission, prepare, session, target, ownerKey };
}

describe("pending-question dictation targets", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it("inserts speech into the answer while preserving existing text", async () => {
    const { session, target, commit } = setup();
    await session.start(target);
    expect(commit).not.toHaveBeenCalled();
    await session.controller.stop();
    expect(commit).toHaveBeenCalledExactlyOnceWith("Existing answer spoken answer");
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it("replaces only the selected answer text", async () => {
    const { session, draft, commit, ownerKey } = setup();
    await session.start(
      createVoiceInputTarget(
        ownerKey,
        draft.read,
        draft.commit,
        { start: 9, end: 15 },
        draft.subscribe,
      ),
    );
    await session.controller.stop();
    expect(commit).toHaveBeenCalledExactlyOnceWith("Existing spoken answer");
  });

  it.each(["environment", "thread", "request", "question"])(
    "separates the %s identity even with reused question IDs",
    (dimension) => {
      const original = questionDictationOwnerKey(origin, "request", "question");
      const other = questionDictationOwnerKey(
        {
          environmentId:
            dimension === "environment" ? EnvironmentId.make("other") : origin.environmentId,
          threadId: dimension === "thread" ? ThreadId.make("other") : origin.threadId,
        },
        dimension === "request" ? "other" : "request",
        dimension === "question" ? "other" : "question",
      );
      expect(other).not.toBe(original);
    },
  );

  it.each(["preparing", "recording", "transcribing"] as const)(
    "discards a departing question's %s session without touching the new question",
    async (phase) => {
      const { session, target, draft, commit, permission, prepare, ownerKey } = setup();
      const granted = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
      const permissionEntered = Promise.withResolvers<void>();
      const transcript = Promise.withResolvers<string>();
      const transcriptionEntered = Promise.withResolvers<void>();
      if (phase === "preparing")
        permission.mockImplementationOnce(() => {
          permissionEntered.resolve();
          return granted.promise;
        });
      prepare.mockResolvedValue({
        locale: "en-US",
        transcribe: () => {
          transcriptionEntered.resolve();
          return transcript.promise;
        },
      });
      const starting = session.start(target);
      if (phase === "preparing") await permissionEntered.promise;
      else await starting;
      const stopping = phase === "transcribing" ? session.controller.stop() : null;
      if (stopping) await transcriptionEntered.promise;
      expect(session.controller.currentState.phase).toBe(phase);

      draft.deactivate();
      session.cancel(ownerKey);
      const nextDraft = createQuestionDictationDraft(
        questionDictationOwnerKey(origin, "request", "next-question"),
      );
      const nextCommit = vi.fn();
      nextDraft.update("Next answer", nextCommit);
      granted.resolve({ granted: true, canAskAgain: true });
      transcript.resolve("late old answer");
      await starting;
      await stopping;
      expect(commit).not.toHaveBeenCalled();
      expect(nextCommit).not.toHaveBeenCalled();
      expect(nextDraft.read()).toBe("Next answer");
      expect(session.controller.currentState.phase).toBe("idle");
    },
  );

  it("rejects late speech for a removed input even before the controller is cancelled", async () => {
    const { session, target, draft, commit } = setup();
    await session.start(target);
    draft.deactivate();
    await session.controller.stop();
    expect(commit).not.toHaveBeenCalled();
    expect(session.controller.currentState.phase).toBe("error");
  });

  it("does not overwrite an answer edited and restored during recording", async () => {
    const { session, target, draft, commit } = setup();
    await session.start(target);
    draft.update("Changed answer", commit);
    draft.update("Existing answer", commit);
    await session.controller.stop();
    expect(commit).not.toHaveBeenCalled();
    expect(session.controller.currentState.phase).toBe("error");
  });

  it("keeps typed text through failure, retry and cancel", async () => {
    const { session, target, draft, commit, prepare } = setup();
    prepare.mockRejectedValueOnce(new Error("synthetic preparation failure"));
    await session.start(target);
    expect(session.controller.currentState).toMatchObject({ phase: "error", errorAction: "retry" });
    expect(draft.read()).toBe("Existing answer");
    await session.retry();
    expect(session.controller.currentState.phase).toBe("recording");
    session.cancel(target.ownerKey);
    expect(session.controller.currentState.phase).toBe("idle");
    expect(draft.read()).toBe("Existing answer");
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps the answer after a transcription error and inserts text only after a successful retry", async () => {
    const { session, target, draft, commit, prepare } = setup();
    prepare.mockResolvedValueOnce({
      locale: "en-US",
      transcribe: async () => {
        throw new Error("synthetic transcription failure");
      },
    });
    await session.start(target);
    await session.controller.stop();
    expect(session.controller.currentState).toMatchObject({ phase: "error", errorAction: "retry" });
    expect(draft.read()).toBe("Existing answer");
    expect(commit).not.toHaveBeenCalled();
    await session.retry();
    await session.controller.stop();
    expect(commit).toHaveBeenCalledExactlyOnceWith("Existing answer spoken answer");
  });

  it("exposes the existing microphone-settings error and allows dismissal without changing the answer", async () => {
    const { session, target, draft, commit, permission } = setup();
    permission.mockResolvedValueOnce({ granted: false, canAskAgain: false });
    await session.start(target);
    expect(session.controller.currentState).toMatchObject({
      phase: "error",
      errorAction: "settings",
    });
    session.cancel(target.ownerKey);
    expect(session.controller.currentState.phase).toBe("idle");
    expect(draft.read()).toBe("Existing answer");
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not cancel an unrelated normal composer recording", async () => {
    const { session, target, commit } = setup();
    const normalCommit = vi.fn();
    await session.start(
      createVoiceInputTarget(
        "normal-composer",
        () => "Normal draft",
        normalCommit,
        { start: 12, end: 12 },
        () => () => {},
      ),
    );
    session.cancel(target.ownerKey);
    expect(session.controller.currentState.phase).toBe("recording");
    await session.controller.stop();
    expect(normalCommit).toHaveBeenCalledWith("Normal draft spoken answer", { start: 26, end: 26 });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["preparing", "recording", "transcribing", "idle", "error"] as const)(
    "blocks explicit submission only for this request's busy %s target",
    (phase) => {
      const ownerKey = questionDictationOwnerKey(origin, "request", "question");
      const state: VoiceInputState = { phase, error: null, errorAction: null };
      expect(questionDictationBlocksSubmission(origin, "request", ownerKey, state)).toBe(
        ["preparing", "recording", "transcribing"].includes(phase),
      );
      expect(questionDictationBlocksSubmission(origin, "other", ownerKey, state)).toBe(false);
      expect(
        questionDictationBlocksSubmission(
          { ...origin, threadId: ThreadId.make("other") },
          "request",
          ownerKey,
          state,
        ),
      ).toBe(false);
      expect(questionDictationBlocksSubmission(origin, "request", "normal-composer", state)).toBe(
        false,
      );
    },
  );
});
