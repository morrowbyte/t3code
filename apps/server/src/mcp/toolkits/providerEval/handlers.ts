import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProviderEvalSession from "../../../provider/ProviderEvalSession.ts";
import * as ProviderEvalBoat from "../../../provider/ProviderEvalBoat.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProviderEvalToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ProviderEvalToolkit, {
  provider_eval: McpToolAccess.writes(({ request }) =>
    Effect.gen(function* () {
      const service = yield* ProviderEvalSession.ProviderEvalSession;
      return yield* service.run(request).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error.code === "unsupported" || error.code === "unavailable"
                  ? "provider_unavailable"
                  : error.code === "call_mismatch" ||
                      error.code === "payload_too_large" ||
                      error.code === "busy"
                    ? "invalid_request"
                    : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
  provider_eval_boat: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const service = yield* ProviderEvalBoat.ProviderEvalBoat;
      return yield* service.run(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
});
