import type * as Semaphore from "effect/Semaphore";
import type { NodeId, ThreadId } from "@t3tools/contracts";

/** Runtime coordination only: never serialize this with commands or receipts. */
export interface DispatchRuntimeOptions {
  /** Persist cancellation with the child Stop before its interrupt effects can settle the task. */
  readonly delegatedTaskCancellation?: {
    readonly parentThreadId: ThreadId;
    readonly taskId: NodeId;
  };
  readonly voiceIntakeCommitGuard?: {
    readonly semaphore: Semaphore.Semaphore;
    readonly isCurrent: () => boolean;
  };
}
