import { useEffect, useState } from "react";
import {
  COMPOSER_TYPING_IDLE_MS,
  createComposerTypingGuardState,
  updateComposerTypingGuard,
} from "./composerTypingGuard";

export function useComposerTypingGuard(scope: string, requestIds: readonly string[]) {
  const requestsKey = JSON.stringify(requestIds);
  const [snapshot, setSnapshot] = useState(() => ({
    scope,
    requestsKey,
    state: updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "requests",
      requestIds,
      now: Date.now(),
    }),
  }));
  const state = snapshot.state;
  if (snapshot.scope !== scope || snapshot.requestsKey !== requestsKey) {
    setSnapshot((current) => ({
      scope,
      requestsKey,
      state: updateComposerTypingGuard(
        current.scope === scope
          ? current.state
          : { ...createComposerTypingGuardState(), focused: current.state.focused },
        { type: "requests", requestIds, now: Date.now() },
      ),
    }));
  }
  const dispatch = (event: Parameters<typeof updateComposerTypingGuard>[1]) => {
    setSnapshot((current) =>
      current.scope !== scope
        ? current
        : {
            ...current,
            state: updateComposerTypingGuard(current.state, event),
          },
    );
  };
  const onDraftChange = () => dispatch({ type: "type", now: Date.now() });
  const onFocus = () => dispatch({ type: "focus" });
  const onBlur = () => dispatch({ type: "blur" });
  const onSend = () => dispatch({ type: "send" });
  const onVoiceDraftActiveChange = (active: boolean) => dispatch({ type: "voice", active });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a timer that releases held requests once typing has been idle long enough
  useEffect(() => {
    if (state.held.size === 0 || state.voiceDraftActive) return;
    const timeout = window.setTimeout(
      () => dispatch({ type: "idle" }),
      Math.max(0, state.lastTypedAt + COMPOSER_TYPING_IDLE_MS - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [state.held, state.lastTypedAt, state.voiceDraftActive, dispatch]);
  return {
    heldRequestIds: state.held,
    voiceDraftActive: state.voiceDraftActive,
    onDraftChange,
    onFocus,
    onBlur,
    onSend,
    onVoiceDraftActiveChange,
  };
}
