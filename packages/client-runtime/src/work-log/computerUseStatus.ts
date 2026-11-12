import type {
  OrchestrationV2TurnItem,
  OrchestrationV2ExecutionNode,
  OrchestrationV2RunAttempt,
  RunId,
} from "@t3tools/contracts";
import { dynamicToolSurface, toolActivitySourceTitle } from "@t3tools/shared/toolActivity";
import * as DateTime from "effect/DateTime";
import {
  computerObservationReceipt,
  isNativeObservationTool,
} from "./computerObservationReceipt.ts";

type ComputerTool = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

const active = new Set(["pending", "running", "waiting"]);

function nativeOperation(name: string | null): string | undefined {
  return name?.match(
    /^(?:mcp__weasel_desktop__|weasel_desktop[./])?desktop_(observe|semantic|semantic_direct|act|status|set_observation_mode|windows|cancel|takeover|recover_release)$/u,
  )?.[1];
}

function computerTool(item: OrchestrationV2TurnItem): ComputerTool | undefined {
  return item.type === "dynamic_tool" &&
    (item.toolSurface === "computer" ||
      item.toolSource?.kind === "computer" ||
      dynamicToolSurface(item.toolName, item.input) === "computer" ||
      nativeOperation(item.toolName) !== undefined)
    ? item
    : undefined;
}

function runningPhase(item: ComputerTool) {
  if (item.status === "pending") return "Waiting to start";
  if (item.status === "waiting") return "Waiting for tool";
  switch (nativeOperation(item.toolName)) {
    case "observe":
      return "Requesting screen capture";
    case "semantic":
    case "semantic_direct":
      return "Reading accessibility";
    case "act":
      return "Desktop action running";
    case "status":
      return "Reading observation policy";
    case "set_observation_mode":
      return "Changing observation policy";
    case "windows":
      return "Listing windows";
    case "cancel":
    case "takeover":
    case "recover_release":
      return "Requesting input release";
  }
  return "Tool running";
}

export interface ComputerUseStatusState {
  readonly phase: string;
  readonly target: string | null;
  readonly action: string | null;
  readonly startedAt: number | null;
  readonly lastEventAt: number;
  readonly live: boolean;
  readonly failed: boolean;
}

function actionTitle(tool: ComputerTool): string | null {
  if (isNativeObservationTool(tool.toolName)) return null;
  const title = toolActivitySourceTitle(tool) ?? null;
  const operation = nativeOperation(tool.toolName);
  const canonical = (value: string) => value.replace(/[._/\s-]+/gu, "").toLowerCase();
  return operation &&
    title &&
    [tool.toolName ?? "", `desktop_${operation}`].some(
      (name) => canonical(name) === canonical(title),
    )
    ? null
    : title;
}

function status(
  tool: ComputerTool,
  event: OrchestrationV2TurnItem,
  phase: string,
  live: boolean,
): ComputerUseStatusState {
  return {
    phase,
    target:
      tool.toolSource?.kind === "computer" && tool.toolSource.key !== "computer-use"
        ? tool.toolSource.name
        : null,
    action: actionTitle(tool),
    startedAt:
      live && (event.type !== "dynamic_tool" || event.status === "running") && event.startedAt
        ? DateTime.toEpochMillis(event.startedAt)
        : null,
    lastEventAt: DateTime.toEpochMillis(event.updatedAt),
    live,
    failed: event.status === "failed",
  };
}

function later(item: OrchestrationV2TurnItem, previous: OrchestrationV2TurnItem | undefined) {
  if (!previous) return true;
  const difference =
    DateTime.toEpochMillis(item.updatedAt) - DateTime.toEpochMillis(previous.updatedAt);
  return (
    difference > 0 ||
    (difference === 0 &&
      (item.ordinal > previous.ordinal ||
        (item.ordinal === previous.ordinal && item.id > previous.id)))
  );
}

function refersTo(request: OrchestrationV2TurnItem, tool: ComputerTool) {
  return (
    request.parentItemId === tool.id ||
    (request.nodeId !== null && request.nodeId === tool.nodeId) ||
    (request.nativeItemRef !== null &&
      tool.nativeItemRef !== null &&
      request.nativeItemRef.strength === "strong" &&
      tool.nativeItemRef.strength === "strong" &&
      request.nativeItemRef.driver === tool.nativeItemRef.driver &&
      request.nativeItemRef.nativeId === tool.nativeItemRef.nativeId)
  );
}

export function deriveComputerUseStatus({
  items,
  runId,
  isWorking,
  confirmed = true,
}: {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runId: RunId | null;
  readonly isWorking: boolean;
  readonly confirmed?: boolean;
}): ComputerUseStatusState | null {
  if (!isWorking || runId === null) return null;
  let latest: OrchestrationV2TurnItem | undefined;
  let lastNonReasoning: OrchestrationV2TurnItem | undefined;
  let lastComputer: ComputerTool | undefined;
  let runningComputer: ComputerTool | undefined;
  const requests: OrchestrationV2TurnItem[] = [];
  let stopRequest: OrchestrationV2TurnItem | undefined;
  let stopResult: OrchestrationV2TurnItem | undefined;
  let otherWorkActive = false;
  for (const item of items) {
    if (item.runId !== runId) continue;
    if (later(item, latest)) latest = item;
    if (item.type !== "reasoning" && later(item, lastNonReasoning)) lastNonReasoning = item;
    if (item.type === "run_interrupt_result" && later(item, stopResult)) stopResult = item;
    if (item.type === "run_interrupt_request" && later(item, stopRequest)) stopRequest = item;
    if (
      (item.type === "approval_request" || item.type === "user_input_request") &&
      active.has(item.status)
    )
      requests.push(item);
    const computer = computerTool(item);
    if (computer) {
      if (later(computer, lastComputer)) lastComputer = computer;
      if (active.has(computer.status) && later(computer, runningComputer))
        runningComputer = computer;
    } else if (
      (item.type === "dynamic_tool" || item.type === "command_execution") &&
      active.has(item.status)
    ) {
      otherWorkActive = true;
    }
  }
  if (!lastComputer || !latest) return null;
  if (!confirmed)
    return {
      ...status(lastComputer, latest, "Activity unconfirmed", false),
      target: null,
      action: null,
    };
  if (stopResult && !later(lastComputer, stopResult)) return null;
  if (stopRequest && (!stopResult || later(stopRequest, stopResult)))
    return status(runningComputer ?? lastComputer, stopRequest, "Stopping…", true);
  let waitingRequest: OrchestrationV2TurnItem | undefined;
  for (const request of requests) {
    if (refersTo(request, runningComputer ?? lastComputer) && later(request, waitingRequest))
      waitingRequest = request;
  }
  if (runningComputer) {
    return waitingRequest
      ? status(
          runningComputer,
          waitingRequest,
          waitingRequest.type === "approval_request"
            ? "Waiting for approval"
            : "Waiting for response",
          true,
        )
      : status(runningComputer, runningComputer, runningPhase(runningComputer), true);
  }
  if (waitingRequest)
    return status(
      lastComputer,
      waitingRequest,
      waitingRequest.type === "approval_request" ? "Waiting for approval" : "Waiting for response",
      true,
    );
  if (
    latest.type === "reasoning" &&
    latest.streaming &&
    active.has(latest.status) &&
    lastNonReasoning === lastComputer &&
    lastComputer.status === "completed" &&
    !otherWorkActive
  )
    return {
      ...status(lastComputer, latest, "Processing result", true),
      target: null,
      action: null,
    };
  if (latest !== lastComputer) return null;
  const receipt = computerObservationReceipt(lastComputer);
  if (receipt) {
    const outcome =
      lastComputer.status === "failed"
        ? "Tool failed"
        : lastComputer.status === "cancelled" || lastComputer.status === "interrupted"
          ? "Tool stopped"
          : null;
    const phase = outcome
      ? `${outcome} · observation policy unconfirmed`
      : receipt.kind === "unconfirmed"
        ? "Observation policy unconfirmed"
        : receipt.mode === "disabled"
          ? "Observation disabled at this call"
          : receipt.active
            ? "Observation allowed; reading at this call"
            : "Observation allowed; idle at this call";
    return status(lastComputer, lastComputer, phase, false);
  }
  const phase =
    lastComputer.status === "failed"
      ? "Tool failed"
      : lastComputer.status === "cancelled" || lastComputer.status === "interrupted"
        ? "Tool stopped"
        : "Tool finished";
  return status(lastComputer, lastComputer, phase, false);
}

export function computerUseProjectionItems(
  projection: {
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly attempts: ReadonlyArray<
      Pick<OrchestrationV2RunAttempt, "runId" | "rootNodeId" | "status">
    >;
    readonly nodes: ReadonlyArray<
      Pick<OrchestrationV2ExecutionNode, "id" | "rootNodeId" | "parentNodeId">
    >;
  },
  runId: RunId | null,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.rootNodeId, attempt]));
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  return projection.turnItems.filter((item) => {
    if (item.runId !== runId) return false;
    let nodeId = item.nodeId;
    const visited = new Set<typeof nodeId>();
    while (nodeId !== null && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = nodes.get(nodeId);
      const attempt = attempts.get(nodeId) ?? (node && attempts.get(node.rootNodeId));
      if (attempt?.runId === item.runId) return attempt.status !== "superseded";
      if (!node) return true;
      nodeId = node.parentNodeId;
    }
    return true;
  });
}

export function computerUseElapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
