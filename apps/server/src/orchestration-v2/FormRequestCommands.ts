import {
  UserFormField,
  userFormDefinitionError,
  type OrchestrationV2DomainEvent,
  type UserFormSubmitCommand,
} from "@t3tools/contracts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "./ProjectionStore.ts";

const encodeFields = Schema.encodeSync(Schema.fromJsonString(Schema.Array(UserFormField)));

export const plan = Effect.fn("FormRequestCommands.plan")(function* (
  command: UserFormSubmitCommand,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const current = yield* projections.getRuntimeResponseContext(command.threadId, command.requestId);
  if (current.request !== undefined) {
    if (
      current.item?.type !== "user_input_request" ||
      current.item.title !== command.form.title ||
      encodeFields(
        current.item.questions.flatMap((question) => (question.field ? [question.field] : [])),
      ) !== encodeFields(command.form.fields)
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The form request id already belongs to another form.",
      });
    }
    return [];
  }
  const invalid = userFormDefinitionError(command.form.fields);
  const records = yield* projections.getThreadRecords(command.threadId, ["runs"]);
  const run = records.runs.find((candidate) => candidate.id === command.runId);
  if (
    invalid ||
    !run ||
    run.rootNodeId !== command.rootNodeId ||
    !["starting", "running", "waiting"].includes(run.status)
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: invalid ?? "The form's run is no longer active.",
    });
  }
  const now = yield* DateTime.now;
  const ordinal = yield* projections.getNextTurnItemOrdinal(command.threadId);
  const common = {
    threadId: command.threadId,
    runId: command.runId,
    nodeId: command.nodeId,
    occurredAt: now,
  };
  const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [
    {
      ...common,
      type: "node.updated",
      payload: {
        id: command.nodeId,
        threadId: command.threadId,
        runId: command.runId,
        parentNodeId: command.rootNodeId,
        rootNodeId: command.rootNodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: command.requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...common,
      type: "turn-item.updated",
      payload: {
        id: command.turnItemId,
        threadId: command.threadId,
        runId: command.runId,
        nodeId: command.nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "waiting",
        title: command.form.title,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId: command.requestId,
        questions: command.form.fields.map((field) => ({
          id: field.id,
          header: command.form.title,
          question: field.label,
          field,
          options:
            field.type === "select" || field.type === "multiselect"
              ? field.options.map((option) => ({
                  ...option,
                  description: option.description ?? option.label,
                }))
              : [],
          multiSelect: field.type === "multiselect",
          allowCustomAnswer: false,
          required: field.required !== false,
        })),
      },
    },
    {
      ...common,
      type: "runtime-request.updated",
      payload: {
        id: command.requestId,
        nodeId: command.nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "external" },
        createdAt: now,
        resolvedAt: null,
      },
    },
  ];
  return events;
});
