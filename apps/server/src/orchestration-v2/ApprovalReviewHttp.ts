import {
  AuthApprovalReviewRequestScope,
  AuthOrchestrationOperateScope,
  AuthApprovalReviewExecuteScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as ApprovalReviewService from "./ApprovalReviewService.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "approvalReview",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* ApprovalReviewService.ApprovalReviewService;
    return handlers
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
          return yield* service.submit(payload, principal.subject);
        }),
      )
      .handle("read", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          const worker = !principal.scopes.has(AuthApprovalReviewRequestScope);
          yield* requireEnvironmentScope(
            worker ? AuthApprovalReviewExecuteScope : AuthApprovalReviewRequestScope,
          );
          return { ...payload, authority: yield* service.read(payload, principal.subject, worker) };
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
