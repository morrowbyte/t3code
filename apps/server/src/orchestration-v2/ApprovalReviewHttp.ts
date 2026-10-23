import {
  AuthApprovalReviewRequestScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthApprovalReviewExecuteScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as ApprovalReviewService from "./ApprovalReviewService.ts";
import * as HostOrders from "./ApprovalReviewHostOrders.ts";
import * as Receiver from "./ApprovalReviewOrderReceiver.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "approvalReview",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* ApprovalReviewService.ApprovalReviewService;
    const orders = yield* HostOrders.ApprovalReviewHostOrders;
    const receiver = yield* Receiver.ApprovalReviewOrderReceiver;
    return handlers
      .handle("orderCreate", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.flatMap((actor) => orders.create(payload, actor)),
        ),
      )
      .handle("orderRead", ({ payload }) =>
        EnvironmentAuthenticatedPrincipal.pipe(
          Effect.flatMap((actor) => orders.read(payload.orderId, actor)),
        ),
      )
      .handle("orderCancel", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.flatMap((actor) => orders.cancel(payload.orderId, actor)),
        ),
      )
      .handle("orderReadiness", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.flatMap((actor) => orders.readiness(actor)),
        ),
      )
      .handle("orderReceiverReadiness", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.flatMap((actor) => receiver.readiness(payload, actor)),
        ),
      )
      .handle("orderReceive", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.flatMap((actor) => receiver.receive(payload, actor)),
        ),
      )
      .handle("identity", () =>
        Effect.gen(function* () {
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return { sessionId: principal.sessionId, subject: principal.subject };
        }),
      )
      .handle("ready", () =>
        Effect.gen(function* () {
          const principal = yield* requireEnvironmentScope(AuthApprovalReviewExecuteScope);
          return yield* service.ready(principal.subject);
        }),
      )
      .handle("submit", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* requireEnvironmentScope(AuthApprovalReviewRequestScope);
          return yield* service.submit(payload, principal);
        }),
      )
      .handle("read", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          const worker = !principal.scopes.has(AuthApprovalReviewRequestScope);
          yield* requireEnvironmentScope(
            worker ? AuthApprovalReviewExecuteScope : AuthApprovalReviewRequestScope,
          );
          return {
            ...payload,
            authority: yield* service.read(payload, worker ? principal.subject : principal, worker),
          };
        }),
      )
      .handle("claim", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* requireEnvironmentScope(AuthApprovalReviewExecuteScope);
          return {
            threadId: payload.threadId,
            requestId: payload.requestId,
            authority: yield* service.claim(payload, principal.subject),
          };
        }),
      )
      .handle("receipt", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* requireEnvironmentScope(AuthApprovalReviewExecuteScope);
          return {
            threadId: payload.threadId,
            requestId: payload.requestId,
            authority: yield* service.receipt(payload, principal.subject),
          };
        }),
      );
  }),
);
