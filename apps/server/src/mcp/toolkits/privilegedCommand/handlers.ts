import * as Effect from "effect/Effect";
import * as PrivilegedCommandService from "../../../orchestration-v2/PrivilegedCommandService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PrivilegedCommandToolkit } from "./tools.ts";

const callerIdentity = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Privileged commands");
  return {
    environmentId: scope.environmentId,
    threadId: thread.threadId,
    providerSessionId: thread.providerSessionId,
  };
});

export const layer = McpToolAccess.toLayer(PrivilegedCommandToolkit, {
  privileged_command_request: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PrivilegedCommandService.PrivilegedCommandService;
      return yield* service.request({ ...input, ...(yield* callerIdentity) });
    }),
  ),
  privileged_command_wait: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PrivilegedCommandService.PrivilegedCommandService;
      return yield* service.wait({ ...input, ...(yield* callerIdentity) });
    }),
  ),
});
