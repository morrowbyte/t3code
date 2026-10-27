import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Broker from "../../connectedEnvironment/Broker.ts";
import { ConnectedEnvironmentToolkit } from "./tools.ts";

const badResponse = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The app relay returned an unexpected result.",
  });
const handlers = {
  t3_connected_environments: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const result = yield* (yield* Broker.ConnectedEnvironmentBroker).invoke(undefined, undefined);
      if (result.type !== "environments") return yield* badResponse();
      return { environments: result.environments };
    }),
  ),
  t3_connected_thread_list: McpToolAccess.actsAsCaller(({ environmentId, ...input }) =>
    Effect.gen(function* () {
      const response = yield* (yield* Broker.ConnectedEnvironmentBroker).invoke(environmentId, {
        type: "list",
        input,
      });
      if (response.type !== "relay" || response.result.type !== "list") return yield* badResponse();
      return response.result.result;
    }),
  ),
  t3_connected_project_list: McpToolAccess.actsAsCaller(({ environmentId, ...input }) =>
    Effect.gen(function* () {
      const response = yield* (yield* Broker.ConnectedEnvironmentBroker).invoke(environmentId, {
        type: "projects",
        input,
      });
      if (response.type !== "relay" || response.result.type !== "projects")
        return yield* badResponse();
      return response.result.result;
    }),
  ),
  t3_connected_thread_read: McpToolAccess.actsAsCaller(({ environmentId, ...input }) =>
    Effect.gen(function* () {
      const response = yield* (yield* Broker.ConnectedEnvironmentBroker).invoke(environmentId, {
        type: "read",
        input,
      });
      if (response.type !== "relay" || response.result.type !== "read") return yield* badResponse();
      return response.result.result;
    }),
  ),
  t3_connected_thread_send: McpToolAccess.actsAsCaller(({ environmentId, ...input }) =>
    Effect.gen(function* () {
      const response = yield* (yield* Broker.ConnectedEnvironmentBroker).invoke(environmentId, {
        type: "send",
        input,
      });
      if (response.type !== "relay" || response.result.type !== "send") return yield* badResponse();
      return response.result.result;
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ConnectedEnvironmentToolkit.tools>;
export const layer = McpToolAccess.toLayer(ConnectedEnvironmentToolkit, handlers);
