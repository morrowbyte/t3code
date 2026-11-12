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

const agentBoatAction = Schema.Union([
  BoatAction.members[0],
  Schema.Struct({
    ...BoatAction.members[1].fields,
    ttlMinutes: BoatDefaults.fields.ttlMinutes,
  }),
  BoatAction.members[2],
  BoatAction.members[3],
]);

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
      "Read Boat account capacity, project budget and thread-owned VMs with expiry times. Boat is optional additional compute; enabling it does not require moving ordinary thread work off the local host. No API keys are returned.",
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
      "Manage optional thread-owned Boat VMs: start, prepare, exec, preview, renew, stop, resume or delete. Start, resume and renew require explicit ttlMinutes (usually 60); the VM stops at that deadline even while the agent is idle or awaiting user input. Start uses a unique requestId; reuse it after an uncertain reply. Exec normally runs for up to 20 seconds. For a finite background job, set backgroundSeconds (1–86400); it returns the provider processId and commandId in instances[].commands. Use logs or cancel with that processId to inspect or stop only that registered command. Without processId, logs and cancel target the dev server. Running commands retain their VM until they end; VM TTL, budget and explicit stop still apply. Prepare syncs non-ignored working source, including deleted files, preserving the running dev process, dependencies and caches. Wait for idle or ready before prepare; prepare again after local edits. Preview opens the configured web or desktop target; use returned managed controls for UI interaction. Before expiry, renew only for work still needed, or preserve commits and artifacts and stop. Stop retains the disk; delete discards it. A failed VM operation is local to that VM and must not block unrelated work. Account setup belongs in Settings.",
    parameters: Schema.Struct({
      request: agentBoatAction,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
  }).annotate(Tool.Destructive, true),
);
