import type * as Semaphore from "effect/Semaphore";

/** Runtime coordination only: never serialize this with commands or receipts. */
export interface DispatchRuntimeOptions {
  readonly voiceIntakeCommitGuard?: {
    readonly semaphore: Semaphore.Semaphore;
    readonly isCurrent: () => boolean;
  };
}
