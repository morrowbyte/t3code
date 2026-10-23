import {
  CommandId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "./ThreadManagementService.ts";

export const conversationTaskRuns = (projection: OrchestrationV2ThreadProjection, taskId: NodeId) =>
  projection.runs.filter(
    (run) =>
      run.delegationAdmission === undefined &&
      (run.delegatedTaskId === taskId ||
        (run.delegatedTaskId === undefined &&
          projection.thread.forkedFrom?.type === "node" &&
          projection.thread.forkedFrom.nodeId === taskId)),
  );
type ThreadManagementDelegateInput = Omit<
  ThreadManagementService.ThreadManagementSendInput,
  "mode" | "attachments" | "modelSelection" | "scheduledTaskId"
> & {
  readonly delegation: NonNullable<
    Extract<OrchestrationV2Command, { type: "message.dispatch" }>["delegation"]
  >;
};

export class ConversationWorkError extends Schema.TaggedError<ConversationWorkError>()(
  "ConversationWorkError",
  {
    threadId: ThreadId,
    taskId: NodeId,
    reason: Schema.Literals(["task_not_found", "task_mismatch", "run_not_found", "inactive"]),
  },
) {
  override get message() {
    return `The conversation task is unavailable (${this.reason}).`;
  }
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const delegate = Effect.fn("ConversationWorkCoordinator.delegate")(function* (
    input: ThreadManagementDelegateInput,
  ) {
    yield* threads.getProjectThread(input);
    const result = yield* threads.dispatch({
      type: "message.dispatch",
      commandId: input.commandId,
      threadId: input.threadId,
      messageId: input.messageId,
      text: input.text,
      attachments: [],
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
      delegation: input.delegation,
      dispatchMode: { type: "start_immediately" },
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });
    const task = result.storedEvents.find(
      (stored) =>
        stored.event.type === "subagent.updated" && stored.event.threadId === input.threadId,
    )?.event;
    const child =
      task?.type === "subagent.updated" && task.payload.childThreadId !== null
        ? yield* threads.getThreadProjection(task.payload.childThreadId)
        : undefined;
    const created = result.storedEvents.find(
      (stored) => stored.event.type === "run.created" && stored.event.threadId === child?.thread.id,
    )?.event;
    const run =
      created?.type === "run.created"
        ? child?.runs.find((candidate) => candidate.id === created.payload.id)
        : undefined;
    if (
      task?.type !== "subagent.updated" ||
      task.payload.childThreadId === null ||
      task.payload.runId === null ||
      child === undefined ||
      run === undefined
    )
      return yield* new ThreadManagementService.ThreadManagementDurableRunProjectionError({
        threadId: input.threadId,
        messageId: input.messageId,
      });
    return {
      admissionRunId: task.payload.runId,
      messageId: input.messageId,
      taskId: task.payload.id,
      childThreadId: task.payload.childThreadId,
      childRunId: run.id,
      projectId: child.thread.projectId,
      status: run.status,
    };
  });

  const read = Effect.fn("ConversationWorkCoordinator.read")(function* (input: {
    readonly threadId: ThreadId;
    readonly taskId: NodeId;
    readonly runId?: RunId;
  }) {
    const parent = yield* threads.getThreadProjection(input.threadId);
    const task = parent.subagents.find((candidate) => candidate.id === input.taskId);
    if (task?.origin !== "app_owned" || task.childThreadId === null)
      return yield* new ConversationWorkError({ ...input, reason: "task_not_found" });
    const projection = yield* threads.getThreadProjection(task.childThreadId);
    const workRuns = conversationTaskRuns(projection, input.taskId);
    if (
      parent.thread.deletedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.thread.lineage.parentThreadId !== parent.thread.id ||
      projection.thread.lineage.relationshipToParent !== "subagent" ||
      projection.thread.forkedFrom?.type !== "node" ||
      (projection.thread.forkedFrom.nodeId !== task.id && workRuns.length === 0)
    )
      return yield* new ConversationWorkError({ ...input, reason: "task_mismatch" });
    const run =
      input.runId === undefined
        ? workRuns.toSorted((left, right) => right.ordinal - left.ordinal)[0]
        : workRuns.find((candidate) => candidate.id === input.runId);
    if (run === undefined)
      return yield* new ConversationWorkError({ ...input, reason: "run_not_found" });
    return { task, projection, run };
  });
  const steer = Effect.fn("ConversationWorkCoordinator.steer")(function* (input: {
    readonly threadId: ThreadId;
    readonly taskId: NodeId;
    readonly runId: RunId;
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly message: string;
    readonly creationSource: "voice" | "mcp";
  }) {
    const { projection, run } = yield* read(input);
    const prior = projection.messages.find((message) => message.id === input.messageId);
    if (prior !== undefined) {
      if (prior.runId !== run.id || prior.text !== input.message)
        return yield* new ConversationWorkError({ ...input, reason: "task_mismatch" });
      return { taskId: input.taskId, threadId: projection.thread.id, runId: run.id };
    }
    if (
      projection.thread.archivedAt !== null ||
      !["starting", "running", "waiting"].includes(run.status)
    )
      return yield* new ConversationWorkError({ ...input, reason: "inactive" });
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: input.commandId,
      threadId: projection.thread.id,
      messageId: input.messageId,
      text: input.message,
      attachments: [],
      dispatchMode: { type: "steer_active", targetRunId: run.id, onInactive: "reject" },
      createdBy: "user",
      creationSource: input.creationSource,
    });
    return { taskId: input.taskId, threadId: projection.thread.id, runId: run.id };
  });
  return { delegate, read, steer };
});

export class ConversationWorkCoordinator extends Context.Service<
  ConversationWorkCoordinator,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/ConversationWorkCoordinator") {}

export const layer = Layer.effect(ConversationWorkCoordinator, make);
