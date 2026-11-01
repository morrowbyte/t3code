import { OrchestratorMcpEnvironmentTarget, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerRouting from "../../../computer/ComputerRouting.ts";
import * as DesktopApplications from "../../../computer/DesktopApplications.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Application = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  executable: Schema.NullOr(Schema.String),
  categories: Schema.Array(Schema.String),
  browser: Schema.Boolean,
  dbusActivatable: Schema.Boolean,
  visible: Schema.Boolean,
  terminal: Schema.Boolean,
  desktopActions: Schema.Array(Schema.String),
  flatpakId: Schema.NullOr(Schema.String),
  toolkitHint: Schema.Literals(["gtk", "qt", "unknown"]),
});

export const ComputerToolkit = Toolkit.make(
  Tool.make("computer_apps", {
    description:
      "Find installed desktop launchers on this environment without opening apps or reading app contents. Linux uses XDG desktop IDs and precedence. Filter by query; limit 1-200 (default 80). Metadata, toolkit hints and D-Bus activation do not prove live automation. Other platforms report unsupported; inspect the native session there. Use when an app identity is unknown, not before every action.",
    parameters: Schema.Struct({
      environmentId: OrchestratorMcpEnvironmentTarget,
      query: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
      limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
      includeHidden: Schema.optional(Schema.Boolean),
    }),
    success: Schema.Struct({
      platform: Schema.String,
      supported: Schema.Boolean,
      complete: Schema.Boolean,
      applications: Schema.Array(Application),
      total: Schema.Number,
      unreadable: Schema.Number,
    }),
    failure: OrchestratorMcpFailure,
    dependencies: [DesktopApplications.DesktopApplications],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("computer_route", {
    description:
      "Resolve an uncertain computer-use target in this thread's environment without input. Unspecified web/dev work prefers an available Crew preview; an explicit browser, systemProfile or currentSession stays on that desktop context. previewProfileId must exist. Never substitute another app/profile when unavailable. Native routes require the client's installed desktop tools and fresh per-target capabilities: authorized app integration first, object accessibility next, guarded visual input last. Foreground input needs the normal single-writer/stop/release protocol; an overlay is not a separate cursor. If the correct tool and target are already known, use them directly.",
    parameters: Schema.Struct({
      target: ComputerRouting.ComputerTarget,
    }),
    success: ComputerRouting.ComputerRoute,
    failure: OrchestratorMcpFailure,
    dependencies: [ComputerRouting.ComputerRouting, McpInvocationContext.McpInvocationContext],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
