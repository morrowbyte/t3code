import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as BoatService from "../../../boat/BoatService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BoatToolkit } from "./tools.ts";

const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
export const layer = McpToolAccess.toLayer(BoatToolkit, {
  boat_defaults: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      return yield* boat.configureDefaults(input).pipe(Effect.mapError(failure));
    }),
  ),
  boat_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      return yield* boat.read(input.projectId).pipe(Effect.mapError(failure));
    }),
  ),
  boat_project: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      return yield* boat.configure(input.projectId, input.config).pipe(Effect.mapError(failure));
    }),
  ),
  boat_environment: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (input.request.action === "preview" && scope.thread)
        yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
          Effect.mapError(failure),
        );
      return yield* boat
        .operate(input.request, scope.thread?.threadId)
        .pipe(Effect.mapError(failure));
    }),
  ),
});
