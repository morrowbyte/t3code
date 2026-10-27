import { OrchestratorMcpFailure, type EnvironmentId } from "@t3tools/contracts";
import type {
  ConnectedEnvironmentRelayRequest,
  ConnectedEnvironmentResult,
} from "../../../../../packages/contracts/src/connectedEnvironmentMcp.ts";
import * as Effect from "effect/Effect";

import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestratorMcp from "../OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../McpInvocationContext.ts";
import { assertTargetWithinLimits } from "../threadAccess.ts";
import * as ProjectService from "../../project/ProjectService.ts";

/** Called only from the authenticated app relay RPC, after its scope check. */
export const executeConnectedEnvironmentRequest = Effect.fn("connectedEnvironment.target")(
  function* (
    targetEnvironmentId: EnvironmentId,
    envelope: ConnectedEnvironmentRelayRequest,
    expiresAtMonotonicMs?: number,
  ) {
    if (targetEnvironmentId !== envelope.targetEnvironmentId) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The connected environment does not match the requested target.",
      });
    }
    const service = yield* OrchestratorMcp.OrchestratorMcpService;
    const caller = envelope.caller;
    // Do not impersonate a local provider thread. The authenticated app relay
    // carries the source server's limits; the target has no local source run.
    const scope: McpInvocationScope = {
      environmentId: targetEnvironmentId,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
      // A provider session can change after a disconnect. The same source
      // thread and retry key must still address the same durable receipt.
      requestNamespace: `connected:${encodeURIComponent(caller.environmentId)}:${encodeURIComponent(caller.threadId)}`,
      thread: undefined,
      remoteSender: { environmentId: caller.environmentId, threadId: caller.threadId },
      client: {
        sessionId: "connected-environment-relay",
        label: "Connected environment relay",
        access: caller.runtimeMode,
      },
    };
    const request = envelope.request;
    if (request.type === "projects") {
      const projects = yield* ProjectService.ProjectService;
      const snapshot = yield* projects.snapshot.pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not list projects.",
            }),
        ),
      );
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = request.input.cursor ?? 0;
      const end = start + 100;
      return {
        type: "projects",
        result: {
          projects: rows.slice(start, end).map(({ id, title }) => ({ id, title })),
          nextCursor: end < rows.length ? end : null,
        },
      } satisfies ConnectedEnvironmentResult;
    }
    if (request.type === "list") {
      return {
        type: "list",
        result: yield* service.listThreads(scope, request.input),
      } satisfies ConnectedEnvironmentResult;
    }
    if (request.type === "read") {
      return {
        type: "read",
        result: yield* service.readThread(scope, request.input),
      } satisfies ConnectedEnvironmentResult;
    }
    if (expiresAtMonotonicMs === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "A connected environment admission is required.",
      });
    }
    const threads = yield* ThreadManagement.ThreadManagementService;
    const target = yield* threads.getThreadShell(request.input.threadId).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Could not read target thread.",
          }),
      ),
    );
    if (target === null || target.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The target thread was not found.",
      });
    }
    const limits = { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode };
    yield* assertTargetWithinLimits(limits, target);
    const result = yield* service
      .sendToThread(scope, request.input)
      .pipe(Effect.provideService(DispatchModeLimit, { ...limits, expiresAtMonotonicMs }));
    return { type: "send", result } satisfies ConnectedEnvironmentResult;
  },
);
