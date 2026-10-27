import { OrchestratorMcpFailure, type EnvironmentId } from "@t3tools/contracts";
import type {
  ConnectedEnvironmentBridgeEvent,
  ConnectedEnvironmentBridgeRequest,
  ConnectedEnvironmentBridgeResponse,
  ConnectedEnvironmentBridgeResult,
  ConnectedEnvironmentRequest,
} from "../../../../../packages/contracts/src/connectedEnvironmentMcp.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import { assertLiveCaller, readCaller } from "../threadAccess.ts";

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });
type Pending = Deferred.Deferred<ConnectedEnvironmentBridgeResult, OrchestratorMcpFailure>;
interface Connection {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly queue: Queue.Queue<ConnectedEnvironmentBridgeEvent, Cause.Done>;
  readonly pending: Map<string, Pending>;
}

export class ConnectedEnvironmentBroker extends Context.Service<
  ConnectedEnvironmentBroker,
  {
    readonly connect: (
      sessionId: string,
    ) => Effect.Effect<Stream.Stream<ConnectedEnvironmentBridgeEvent>>;
    readonly respond: (
      sessionId: string,
      response: ConnectedEnvironmentBridgeResponse,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly invoke: (
      target: EnvironmentId | undefined,
      request: ConnectedEnvironmentRequest | undefined,
    ) => Effect.Effect<
      ConnectedEnvironmentBridgeResult,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("t3/mcp/connectedEnvironment/Broker/ConnectedEnvironmentBroker") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const threads = yield* ThreadManagement.ThreadManagementService;
  let connection: Connection | undefined;
  const disconnect = Effect.fn("ConnectedEnvironmentBroker.disconnect")(function* (
    current: Connection,
  ) {
    if (connection === current) connection = undefined;
    yield* Queue.shutdown(current.queue);
    yield* Effect.forEach(
      current.pending.values(),
      (pending) =>
        Deferred.fail(pending, failure("The app relay disconnected; the outcome may be unknown.")),
      { discard: true },
    );
    current.pending.clear();
  });
  const connect: ConnectedEnvironmentBroker["Service"]["connect"] = (sessionId) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (connection) yield* disconnect(connection);
            const current: Connection = {
              sessionId,
              connectionId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
              queue: yield* Queue.unbounded<ConnectedEnvironmentBridgeEvent, Cause.Done>(),
              pending: new Map(),
            };
            connection = current;
            yield* Queue.offer(current.queue, {
              type: "connected",
              connectionId: current.connectionId,
            });
            return current;
          }),
          disconnect,
        ).pipe(Effect.map((current) => Stream.fromQueue(current.queue))),
      ),
    );
  const respond: ConnectedEnvironmentBroker["Service"]["respond"] = Effect.fn(
    "ConnectedEnvironmentBroker.respond",
  )(function* (sessionId: string, response: ConnectedEnvironmentBridgeResponse) {
    const current = connection;
    if (
      !current ||
      current.sessionId !== sessionId ||
      current.connectionId !== response.connectionId
    )
      return yield* failure("App relay session is no longer active.");
    const pending = current.pending.get(response.requestId);
    if (!pending) return yield* failure("App relay request is no longer active.");
    current.pending.delete(response.requestId);
    if (response.error !== undefined || response.result === undefined) {
      yield* Deferred.fail(pending, failure("The app relay failed; the outcome may be unknown."));
    } else {
      yield* Deferred.succeed(pending, response.result);
    }
  });
  const exchange = Effect.fn("ConnectedEnvironmentBroker.exchange")(function* (
    current: Connection,
    bridgeRequest: ConnectedEnvironmentBridgeRequest,
  ) {
    if (connection !== current) return yield* failure("The app relay disconnected.");
    const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const deferred = yield* Deferred.make<
      ConnectedEnvironmentBridgeResult,
      OrchestratorMcpFailure
    >();
    current.pending.set(requestId, deferred);
    return yield* Effect.gen(function* () {
      const offered = yield* Queue.offer(current.queue, {
        type: "request",
        connectionId: current.connectionId,
        requestId,
        request: bridgeRequest,
      });
      if (!offered) return yield* failure("App relay disconnected before admission.");
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(20_000));
      if (Option.isNone(result))
        return yield* failure(
          "App relay timed out; the outcome may be unknown. Retry only with the same clientRequestId.",
        );
      if (result.value.type !== bridgeRequest.type)
        return yield* failure("App relay returned a mismatched response.");
      return result.value;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          current.pending.delete(requestId);
        }),
      ),
    );
  });
  const invoke: ConnectedEnvironmentBroker["Service"]["invoke"] = Effect.fn(
    "ConnectedEnvironmentBroker.invoke",
  )(function* (
    target: EnvironmentId | undefined,
    request: ConnectedEnvironmentRequest | undefined,
  ) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const threadScope = yield* McpInvocationContext.requireThreadScope(
      scope,
      "Connected environment relay",
    );
    if ((target === undefined) !== (request === undefined))
      return yield* failure("Invalid relay request.");
    if (target === scope.environmentId)
      return yield* failure("The target must be a different connected environment.");
    const current = connection;
    if (!current) return yield* failure("No connected app relay is available.");
    let admissionId: string | undefined;
    if (request?.type === "send" && target !== undefined) {
      const prepared = yield* exchange(current, { type: "prepare", targetEnvironmentId: target });
      if (prepared.type !== "prepare")
        return yield* failure("App relay returned an invalid admission.");
      admissionId = prepared.admissionId;
    }
    return yield* locks.withLock(
      threadScope.thread.threadId,
      Effect.gen(function* () {
        const caller = yield* readCaller();
        yield* assertLiveCaller(caller);
        const bridgeRequest: ConnectedEnvironmentBridgeRequest =
          target === undefined || request === undefined
            ? { type: "environments" }
            : {
                type: "relay",
                envelope: {
                  targetEnvironmentId: target,
                  caller: {
                    environmentId: scope.environmentId,
                    threadId: threadScope.thread.threadId,
                    ...caller.limits,
                  },
                  request,
                  ...(admissionId === undefined ? {} : { admissionId }),
                },
              };
        return yield* exchange(current, bridgeRequest).pipe(
          // A lost response can leave the destination in flight. The token was
          // issued before this lock and expires within ten seconds on the target.
          Effect.onError(() => (admissionId === undefined ? Effect.void : Effect.sleep(10_000))),
        );
      }).pipe(Effect.provideService(ThreadManagement.ThreadManagementService, threads)),
    );
  });
  return ConnectedEnvironmentBroker.of({ connect, respond, invoke });
});

export const layer = Layer.effect(ConnectedEnvironmentBroker, make);
