import { describe, expect, it } from "vite-plus/test";
import { createComposerTypingGuardState, updateComposerTypingGuard } from "./composerTypingGuard";

function typing() {
  return updateComposerTypingGuard(
    updateComposerTypingGuard(createComposerTypingGuardState(), { type: "focus" }),
    { type: "type", now: 1000 },
  );
}

describe("composer typing guard", () => {
  it("holds new questions throughout dictation, focus loss and transcription until send", () => {
    let state = updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "voice",
      active: true,
    });
    state = updateComposerTypingGuard(state, {
      type: "requests",
      requestIds: ["question"],
      now: 10_000,
    });
    for (const type of ["blur", "idle", "focus", "idle"] as const) {
      state = updateComposerTypingGuard(state, { type });
      expect([...state.held]).toEqual(["question"]);
    }
    state = updateComposerTypingGuard(state, {
      type: "requests",
      requestIds: ["question", "second"],
      now: 30_000,
    });
    expect([...state.held]).toEqual(["question", "second"]);
    state = updateComposerTypingGuard(state, { type: "send" });
    expect([...state.held]).toEqual([]);
    expect(state.voiceDraftActive).toBe(false);
    state = updateComposerTypingGuard(state, {
      type: "requests",
      requestIds: ["question", "second", "third"],
      now: 31_000,
    });
    expect([...state.held]).toEqual([]);
  });

  it("releases on discard and drops withdrawn requests without hiding existing questions", () => {
    let state = updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "requests",
      requestIds: ["existing"],
      now: 0,
    });
    state = updateComposerTypingGuard(state, { type: "voice", active: true });
    state = updateComposerTypingGuard(state, {
      type: "requests",
      requestIds: ["existing", "withdrawn", "new"],
      now: 10_000,
    });
    state = updateComposerTypingGuard(state, {
      type: "requests",
      requestIds: ["existing", "new"],
      now: 11_000,
    });
    expect([...state.held]).toEqual(["new"]);
    state = updateComposerTypingGuard(state, { type: "voice", active: false });
    expect([...state.held]).toEqual([]);
  });

  it.each(["idle", "send", "blur"] as const)(
    "releases on %s and never re-holds the request",
    (type) => {
      let state = updateComposerTypingGuard(typing(), {
        type: "requests",
        requestIds: ["question"],
        now: 1200,
      });
      state = updateComposerTypingGuard(state, { type });
      expect([...state.held]).toEqual([]);
      state = updateComposerTypingGuard(state, { type: "focus" });
      state = updateComposerTypingGuard(state, { type: "type", now: 2000 });
      state = updateComposerTypingGuard(state, { type: "requests", requestIds: [], now: 2100 });
      state = updateComposerTypingGuard(state, {
        type: "requests",
        requestIds: ["question", "new-question"],
        now: 2200,
      });
      expect([...state.held]).toEqual(["new-question"]);
    },
  );

  it("does not hide a request that already took over when typing starts", () => {
    let state = updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "requests",
      requestIds: ["question"],
      now: 0,
    });
    state = updateComposerTypingGuard(state, { type: "focus" });
    state = updateComposerTypingGuard(state, { type: "type", now: 1000 });
    state = updateComposerTypingGuard(state, {
      type: "requests",
      requestIds: ["question"],
      now: 1100,
    });
    expect([...state.held]).toEqual([]);
  });
});
