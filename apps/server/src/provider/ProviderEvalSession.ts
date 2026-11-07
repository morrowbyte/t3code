import { ModelSelection, type ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Crypto from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const text = Schema.String.check(Schema.isMaxLength(65_536));
const maximumPayloadLength = 262_144;
const sessionLifetime = "10 minutes";

const Start = Schema.Struct({
  action: Schema.Literal("start"),
  clientRequestId: Schema.optional(identifier),
  modelSelection: ModelSelection,
  instructions: text,
  input: text,
  tools: Schema.Array(
    Schema.Struct({ name: identifier, description: text, inputSchema: Schema.Json }),
  ).check(Schema.isMaxLength(32)),
});
const Respond = Schema.Struct({
  action: Schema.Literal("respond"),
  evaluationId: identifier,
  callId: identifier,
  contentItems: Schema.Array(Schema.Struct({ type: Schema.Literal("inputText"), text })).check(
    Schema.isMaxLength(16),
  ),
  success: Schema.Boolean,
});
const Cancel = Schema.Struct({ action: Schema.Literal("cancel"), evaluationId: identifier });
export const ProviderEvalRequest = Schema.Union([Start, Respond, Cancel]);
export type ProviderEvalRequest = typeof ProviderEvalRequest.Type;
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(ProviderEvalRequest));
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const ToolCall = Schema.Struct({
  type: Schema.Literal("tool_call"),
  evaluationId: identifier,
  callId: identifier,
  name: identifier,
  namespace: Schema.optional(identifier),
  arguments: Schema.Json,
  visibleText: Schema.optional(Schema.String.check(Schema.isMaxLength(maximumPayloadLength))),
});
const decodeToolCall = Schema.decodeUnknownEffect(ToolCall);
const encodeToolCall = Schema.encodeSync(Schema.fromJsonString(ToolCall));
const Complete = Schema.Struct({
  type: Schema.Literal("complete"),
  evaluationId: identifier,
  text: Schema.String.check(Schema.isMaxLength(maximumPayloadLength)),
  visibleText: Schema.optional(Schema.String.check(Schema.isMaxLength(maximumPayloadLength))),
});
export const ProviderEvalResponse = Schema.Union([
  ToolCall,
  Complete,
  Schema.Struct({ type: Schema.Literal("cancelled"), evaluationId: identifier }),
]);
export type ProviderEvalResponse = typeof ProviderEvalResponse.Type;

const messages = {
  unavailable: "Provider evaluation session is unavailable to this caller.",
  unsupported: "This provider does not support isolated evaluations.",
  capacity: "Provider evaluation capacity is full. Cancel an evaluation before starting another.",
  payload_too_large: "Provider evaluation payload exceeds the supported size.",
  call_mismatch: "This tool call is not awaiting a response in this evaluation.",
  busy: "Another response is already waiting for this evaluation's next event.",
  expired: "Provider evaluation expired and its native session was closed.",
  cancelled: "Provider evaluation was cancelled and its native session was closed.",
  provider_failed: "Provider evaluation failed and its native session was closed.",
} as const;

export class ProviderEvalSessionError extends Schema.TaggedError<ProviderEvalSessionError>()(
  "ProviderEvalSessionError",
  {
    code: Schema.Literals([
      "unavailable",
      "unsupported",
      "capacity",
      "payload_too_large",
      "call_mismatch",
      "busy",
      "expired",
      "cancelled",
      "provider_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return messages[this.code];
  }
}

type Event = typeof ToolCall.Type | typeof Complete.Type;
type Reply = Effect.Success<
  ReturnType<ProviderAdapter.ProviderAdapterV2EvaluationInput["onToolCall"]>
>;

interface Session {
  readonly id: string;
  readonly owner: string;
  readonly clientRequestId: string | undefined;
  readonly scope: Scope.Closeable;
  readonly first: Deferred.Deferred<Event, ProviderEvalSessionError>;
  readonly events: Queue.Queue<Event, ProviderEvalSessionError>;
  readonly pending: Map<string, Deferred.Deferred<Reply>>;
  readonly seen: Set<string>;
  readonly closed: Deferred.Deferred<void>;
  firstPublished: boolean;
  reading: boolean;
  closing: boolean;
  terminal: Exit.Exit<Event, ProviderEvalSessionError> | undefined;
}

export class ProviderEvalSession extends Context.Service<
  ProviderEvalSession,
  {
    readonly run: (
      request: ProviderEvalRequest,
    ) => Effect.Effect<
      ProviderEvalResponse,
      ProviderEvalSessionError,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("t3/provider/ProviderEvalSession") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.SecureRandom;
  const serviceScope = yield* Scope.Scope;
  const admission = yield* Semaphore.make(1);
  const sessions = new Map<string, Session>();

  const publish = Effect.fn("ProviderEvalSession.publish")(function* (
    session: Session,
    event: Event,
  ) {
    if (!session.firstPublished) {
      session.firstPublished = true;
      yield* Deferred.succeed(session.first, event);
    } else {
      yield* Queue.offer(session.events, event);
    }
  });

  const finish = Effect.fn("ProviderEvalSession.finish")(function* (
    session: Session,
    result: Exit.Exit<ProviderAdapter.ProviderAdapterV2EvaluationResult, ProviderEvalSessionError>,
  ) {
    if (session.terminal !== undefined) return;
    if (Exit.isFailure(result)) {
      const error = new ProviderEvalSessionError({ code: "provider_failed", cause: result.cause });
      session.terminal = Exit.fail(error);
      yield* Deferred.fail(session.first, error);
      yield* Queue.fail(session.events, error);
    } else {
      const event: Event = { type: "complete", evaluationId: session.id, ...result.value };
      session.terminal = Exit.succeed(event);
      yield* publish(session, event);
    }
    session.pending.clear();
  });

  const dispose = Effect.fn("ProviderEvalSession.dispose")(function* (
    session: Session,
    reason: "expired" | "cancelled",
  ) {
    if (session.closing) return yield* Deferred.await(session.closed);
    session.closing = true;
    const error = new ProviderEvalSessionError({ code: reason });
    session.terminal = Exit.fail(error);
    yield* Scope.close(session.scope, Exit.void);
    session.pending.clear();
    sessions.delete(session.id);
    yield* Deferred.fail(session.first, error);
    yield* Queue.fail(session.events, error);
    yield* Deferred.succeed(session.closed, undefined);
  }, Effect.uninterruptible);

  const start = Effect.fn("ProviderEvalSession.start")(function* (
    owner: string,
    callerThreadId: ThreadId,
    request: typeof Start.Type,
  ) {
    const session = yield* admission.withPermits(1)(
      Effect.gen(function* () {
        if (request.clientRequestId !== undefined) {
          const previous = Array.from(sessions.values()).find(
            (entry) => entry.owner === owner && entry.clientRequestId === request.clientRequestId,
          );
          if (previous) return previous;
        }
        const caller = yield* threadManagement
          .getThreadShell(callerThreadId)
          .pipe(
            Effect.mapError(
              (cause) => new ProviderEvalSessionError({ code: "unavailable", cause }),
            ),
          );
        if (
          !caller ||
          !(yield* threadManagement.isProviderInstanceEnabledForProject({
            projectId: caller.projectId,
            instanceId: request.modelSelection.instanceId,
          }))
        ) {
          return yield* new ProviderEvalSessionError({ code: "unavailable" });
        }
        if (sessions.size >= 32) {
          const retired = Array.from(sessions.values()).find(
            (entry) => entry.terminal !== undefined && !entry.closing && !entry.reading,
          );
          if (!retired) return yield* new ProviderEvalSessionError({ code: "capacity" });
          yield* dispose(retired, "expired");
        }
        const adapter = yield* registry
          .get(request.modelSelection.instanceId)
          .pipe(
            Effect.mapError(
              (cause) => new ProviderEvalSessionError({ code: "unavailable", cause }),
            ),
          );
        const evaluate = adapter.evaluate;
        if (!evaluate) return yield* new ProviderEvalSessionError({ code: "unsupported" });
        const session: Session = {
          id: yield* crypto.uuidV4().pipe(Effect.orDie),
          owner,
          clientRequestId: request.clientRequestId,
          scope: yield* Scope.fork(serviceScope),
          first: yield* Deferred.make<Event, ProviderEvalSessionError>(),
          events: yield* Queue.bounded<Event, ProviderEvalSessionError>(32),
          pending: new Map(),
          seen: new Set(),
          closed: yield* Deferred.make<void>(),
          firstPublished: false,
          reading: false,
          closing: false,
          terminal: undefined,
        };
        sessions.set(session.id, session);
        const onToolCall: ProviderAdapter.ProviderAdapterV2EvaluationInput["onToolCall"] =
          Effect.fn("ProviderEvalSession.onToolCall")(function* (call) {
            const event = yield* decodeToolCall({
              type: "tool_call",
              evaluationId: session.id,
              ...call,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: adapter.driver,
                    detail: "Invalid evaluation tool call",
                    cause,
                  }),
              ),
            );
            const reply = yield* admission.withPermits(1)(
              Effect.gen(function* () {
                if (
                  session.closing ||
                  session.seen.has(event.callId) ||
                  session.seen.size >= 128 ||
                  session.pending.size >= 32 ||
                  encodeToolCall(event).length > maximumPayloadLength
                ) {
                  return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: adapter.driver,
                    detail: "Evaluation tool call is duplicated or exceeds session limits",
                  });
                }
                const reply = yield* Deferred.make<Reply>();
                session.seen.add(event.callId);
                session.pending.set(event.callId, reply);
                return reply;
              }),
            );
            return yield* publish(session, event).pipe(
              Effect.andThen(Deferred.await(reply)),
              Effect.ensuring(
                Effect.sync(() => {
                  session.pending.delete(event.callId);
                }),
              ),
            );
          });
        yield* Effect.suspend(() =>
          evaluate({
            modelSelection: request.modelSelection,
            instructions: request.instructions,
            input: request.input,
            tools: request.tools,
            onToolCall,
          }),
        ).pipe(
          Effect.filterOrFail(
            (result) =>
              result.text.length + (result.visibleText?.length ?? 0) <= maximumPayloadLength,
            () => new ProviderEvalSessionError({ code: "payload_too_large" }),
          ),
          Effect.mapError(
            (cause) => new ProviderEvalSessionError({ code: "provider_failed", cause }),
          ),
          Effect.onExit((result) => finish(session, result)),
          Effect.ignoreCause,
          Effect.interruptible,
          Effect.forkIn(session.scope),
        );
        yield* Deferred.await(session.closed).pipe(
          Effect.timeoutOrElse({
            duration: sessionLifetime,
            orElse: () => dispose(session, "expired"),
          }),
          Effect.interruptible,
          Effect.forkIn(serviceScope),
        );
        return session;
      }).pipe(Effect.uninterruptible),
    );
    return yield* Deferred.await(session.first).pipe(
      Effect.onInterrupt(() => dispose(session, "cancelled")),
    );
  });

  const respond = Effect.fn("ProviderEvalSession.respond")(function* (
    session: Session,
    request: typeof Respond.Type,
  ) {
    const reply = session.pending.get(request.callId);
    if (!reply) return yield* new ProviderEvalSessionError({ code: "call_mismatch" });
    if (session.reading) return yield* new ProviderEvalSessionError({ code: "busy" });
    session.reading = true;
    session.pending.delete(request.callId);
    return yield* Deferred.succeed(reply, {
      contentItems: request.contentItems,
      success: request.success,
    }).pipe(
      Effect.andThen(Effect.suspend(() => session.terminal ?? Queue.take(session.events))),
      Effect.onInterrupt(() => dispose(session, "cancelled")),
      Effect.ensuring(
        Effect.sync(() => {
          session.reading = false;
        }),
      ),
    );
  });

  const run: ProviderEvalSession["Service"]["run"] = Effect.fn("ProviderEvalSession.run")(
    function* (request) {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("orchestration").pipe(
        Effect.mapError((cause) => new ProviderEvalSessionError({ code: "unavailable", cause })),
      );
      const owner = encodeOwner([
        scope.environmentId,
        scope.thread.threadId,
        scope.thread.providerSessionId,
        scope.thread.providerInstanceId,
      ]);
      if (encodeRequest(request).length > maximumPayloadLength)
        return yield* new ProviderEvalSessionError({ code: "payload_too_large" });
      if (request.action === "start") return yield* start(owner, scope.thread.threadId, request);
      const session = sessions.get(request.evaluationId);
      if (!session || session.owner !== owner || session.closing)
        return yield* new ProviderEvalSessionError({ code: "unavailable" });
      if (request.action === "respond") return yield* respond(session, request);
      yield* dispose(session, "cancelled");
      return { type: "cancelled", evaluationId: session.id };
    },
  );
  return ProviderEvalSession.of({ run });
});

export const layer = Layer.effect(ProviderEvalSession, make);
