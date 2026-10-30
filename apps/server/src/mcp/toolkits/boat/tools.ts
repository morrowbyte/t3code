import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  BoatAction,
  BoatDefaults,
  BoatProjectInput,
  BoatReadInput,
  BoatState,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as BoatService from "../../../boat/BoatService.ts";

const common = {
  success: BoatState,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    BoatService.BoatService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};
export const BoatToolkit = Toolkit.make(
  Tool.make("boat_defaults", {
    ...common,
    description:
      "Set default auto-stop minutes and free stopped-disk retention (0 to 14 days). Project overrides remain independent.",
    parameters: Schema.Struct({
      ...BoatDefaults.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
  }),
  Tool.make("boat_status", {
    ...common,
    description:
      "Read Boat account capacity, project budget and owned cloud environments. No API keys are returned.",
    parameters: Schema.Struct({
      ...BoatReadInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
  }).annotate(Tool.Readonly, true),
  Tool.make("boat_project", {
    ...common,
    description:
      "Configure Boat for a project: enable, size, auto-stop, budget, snapshot and dev commands. Does not start machines or publish releases.",
    parameters: Schema.Struct({
      ...BoatProjectInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
  }),
  Tool.make("boat_environment", {
    ...common,
    description:
      "Start, prepare, exec, preview, stop, resume or delete a project's Boat VM. Start uses a unique requestId; reuse it after an uncertain reply. Exec runs a command for up to 20 seconds in the workspace. Prepare syncs non-ignored working source, including deleted files, into the existing VM. It preserves a running dev process, dependencies and caches; otherwise it installs and launches the configured dev command. After local edits, prepare again with the same requestId, then inspect the existing preview. Stop ends processes but retains disk; delete discards it. Wait for idle or ready before prepare. Crew tracks calling agents and stops their VM when no agent uses it. Renew extends its bounded timeout while working; budget still applies. Resume stopped VMs for further work. Account setup belongs in Settings.",
    parameters: Schema.Struct({
      request: BoatAction,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
  }).annotate(Tool.Destructive, true),
);
