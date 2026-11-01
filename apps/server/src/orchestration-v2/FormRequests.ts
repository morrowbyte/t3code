import {
  CommandId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  UserFormField,
  OrchestratorMcpFailure,
  validateUserFormAnswers,
  userFormDefinitionError,
  type RequestFormInput,
  type RequestFormResult,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const encodeFields = Schema.encodeSync(Schema.fromJsonString(Schema.Array(UserFormField)));

export const request = Effect.fn("FormRequests.request")(function* (
  context: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly requestKey: string;
  },
  input: RequestFormInput,
): Effect.fn.Return<
  RequestFormResult,
  OrchestratorMcpFailure,
  ThreadManagementService.ThreadManagementService
> {
  const service = yield* ThreadManagementService.ThreadManagementService;
  const invalid = userFormDefinitionError(input.fields);
  if (invalid)
    return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: invalid });
  const key = encodeURIComponent(`${context.threadId}:${context.runId}:${context.requestKey}`);
  const requestId = RuntimeRequestId.make(`form:${key}`);
  const turnItemId = TurnItemId.make(`form-item:${key}`);
  const mapFailure = (_cause: unknown) =>
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "Could not update the form request.",
    });
  const afterSequence = yield* service
    .getThreadEventSequence(context.threadId)
    .pipe(Effect.mapError(mapFailure));
  yield* service
    .dispatch({
      type: "user-form.submit",
      commandId: CommandId.make(`form-submit:${key}`),
      threadId: context.threadId,
      runId: context.runId,
      rootNodeId: context.rootNodeId,
      requestId,
      nodeId: NodeId.make(`form-node:${key}`),
      turnItemId,
      form: input,
    })
    .pipe(Effect.mapError(mapFailure));
  const { item } = yield* service
    .getTurnItem({ threadId: context.threadId, itemId: turnItemId })
    .pipe(Effect.mapError(mapFailure));
  if (
    item?.type !== "user_input_request" ||
    item.requestId !== requestId ||
    item.title !== input.title ||
    encodeFields(item.questions.flatMap((question) => (question.field ? [question.field] : []))) !==
      encodeFields(input.fields)
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The form request id already belongs to another form.",
    });
  }
  const read = service
    .getThreadRecords(context.threadId, ["runtimeRequests", "runs"], { messageRoles: [] })
    .pipe(
      Effect.map((records) => ({
        request: records.runtimeRequests.find((candidate) => candidate.id === requestId),
        run: records.runs.find((run) => run.id === context.runId),
      })),
      Effect.mapError(mapFailure),
    );
  const finished = (state: Effect.Success<typeof read>) =>
    state.request?.status !== "pending" ||
    !state.run ||
    ThreadManagementService.isTerminalRunStatus(state.run.status);
  const cancel = service
    .dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`form-cancel:${key}`),
      threadId: context.threadId,
      requestId,
      decision: "cancel",
    })
    .pipe(Effect.catch(() => Effect.void));
  const state = yield* Stream.merge(
    service
      .streamStoredEventsFrom({
        threadId: context.threadId,
        afterSequence,
        eventType: "runtime-request.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "runtime-request.updated" &&
            stored.event.payload.id === requestId,
        ),
        Stream.mapEffect(() => read),
      ),
    service
      .streamStoredEventsFrom({
        threadId: context.threadId,
        afterSequence,
        eventType: "run.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.id === context.runId,
        ),
        Stream.mapEffect(() => read),
      ),
  ).pipe(
    Stream.merge(Stream.fromEffect(read)),
    Stream.filter(finished),
    Stream.runHead,
    Effect.timeoutOption(Duration.millis(input.timeoutMs ?? 3600000)),
    Effect.map(Option.flatten),
    Effect.mapError(mapFailure),
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cancel)),
  );
  let resolved = Option.isSome(state) ? state.value.request : undefined;
  let timedOut = false;
  if (Option.isNone(state)) {
    let latest = yield* read;
    if (!finished(latest)) {
      yield* cancel;
      timedOut = true;
      latest = yield* read;
    }
    resolved = latest.request;
  }
  if (
    resolved?.status !== "resolved" ||
    resolved.decision === "cancel" ||
    resolved.decision === "decline"
  ) {
    if (Option.isSome(state)) yield* cancel;
    return { requestId, status: timedOut ? "timed_out" : "cancelled" };
  }
  const validated = validateUserFormAnswers(item.questions, resolved.answers ?? {});
  if (Object.keys(validated.errors).length > 0) {
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "The stored form answers are invalid.",
    });
  }
  return { requestId, status: "submitted", answers: validated.answers };
});
