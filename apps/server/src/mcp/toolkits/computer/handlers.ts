import * as Effect from "effect/Effect";
import * as ComputerRouting from "../../../computer/ComputerRouting.ts";
import * as DesktopApplications from "../../../computer/DesktopApplications.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ComputerToolkit, {
  computer_apps: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const applications = yield* DesktopApplications.DesktopApplications;
      return yield* applications.list(input);
    }),
  ),
  computer_route: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const routing = yield* ComputerRouting.ComputerRouting;
      const scope = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "Computer routing",
      );
      return yield* routing.route(input.target, scope);
    }),
  ),
});
