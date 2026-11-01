import * as DateTime from "effect/DateTime";
import type { LiveVoiceController, LiveVoiceState, LiveVoiceTarget } from "./controller.ts";
import { observeVoiceConversation, type ObservedVoiceCall } from "./conversation.ts";

function liveVoiceIsBusy(state: LiveVoiceState): boolean {
  return state.cleanupPending === true || !["idle", "ended", "error"].includes(state.phase);
}

const idle: LiveVoiceState = {
  phase: "idle",
  localMuted: false,
  outputMuted: false,
  transcript: [],
  sessionStatus: null,
  lease: null,
  error: null,
};

export type LiveVoiceSessionSnapshot<Value> = {
  readonly target: LiveVoiceTarget | null;
  readonly controller: LiveVoiceController | null;
  readonly state: LiveVoiceState;
  readonly value: Value | null;
  readonly busy: boolean;
  readonly calls: ReadonlyArray<ObservedVoiceCall>;
};

/** App-owned reservation, including asynchronous prepare and stop cleanup. */
export class LiveVoiceSessionOwner<Value> {
  private snapshot: LiveVoiceSessionSnapshot<Value> = {
    target: null,
    controller: null,
    state: idle,
    value: null,
    busy: false,
    calls: [],
  };
  private readonly listeners = new Set<() => void>();
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(
    target: LiveVoiceTarget,
    create: (onStateChange: (state: LiveVoiceState) => void) => {
      readonly controller: LiveVoiceController;
      readonly value: Value;
    },
  ): Promise<void> {
    if (this.snapshot.busy) return Promise.resolve();
    const capturedTarget = Object.freeze({ ...target });
    this.publish({ ...this.snapshot, target: capturedTarget, busy: true });
    let controller: LiveVoiceController;
    const binding = create((state) => {
      if (this.snapshot.controller !== controller) return;
      this.publish({
        ...this.snapshot,
        state,
        busy: this.starting !== null || this.stopping !== null || liveVoiceIsBusy(state),
        calls: observeVoiceConversation(
          this.snapshot.calls,
          state,
          DateTime.formatIso(DateTime.nowUnsafe()),
        ).slice(-24),
      });
    });
    controller = binding.controller;
    this.publish({
      ...this.snapshot,
      controller,
      value: binding.value,
      state: controller.currentState,
    });
    // Reserve before start can synchronously publish a terminal error or call application code.
    let resolveStart!: () => void;
    let rejectStart!: (error: unknown) => void;
    const starting = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    this.starting = starting;
    void controller.start(capturedTarget).then(resolveStart, rejectStart);
    return starting.finally(() => {
      if (this.starting === starting) this.starting = null;
      this.refreshBusy(controller);
    });
  }

  end = (): Promise<void> => {
    if (this.stopping) return this.stopping;
    const controller = this.snapshot.controller;
    if (!controller) return Promise.resolve();
    const starting = this.starting;
    this.publish({ ...this.snapshot, busy: true });
    const stopping = Promise.resolve().then(async () => {
      await controller.end();
      // A late prepare reply can still own a server lease, even after local media was released.
      await starting;
    });
    this.stopping = stopping;
    return stopping.finally(() => {
      if (this.stopping === stopping) this.stopping = null;
      this.refreshBusy(controller);
    });
  };

  private refreshBusy(controller: LiveVoiceController): void {
    if (this.snapshot.controller !== controller) return;
    this.publish({
      ...this.snapshot,
      busy:
        this.starting !== null || this.stopping !== null || liveVoiceIsBusy(this.snapshot.state),
    });
  }

  private publish(snapshot: LiveVoiceSessionSnapshot<Value>): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
