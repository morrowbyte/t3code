import type { ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ThreadStructureVisibleTurnItem } from "../state/models.ts";
import {
  resolveWorkEntryToolPresentation,
  workEntryExplicitIntentLabel,
  type WorkLogPresentationEntry,
} from "../work-log/presentation.ts";

export function activeVoiceToolActivities(
  rows: ReadonlyArray<ThreadStructureVisibleTurnItem>,
  threadRef: ScopedThreadRef,
) {
  return rows.flatMap(({ item, sourceThreadId, visibility }) => {
    if (
      visibility !== "local" ||
      sourceThreadId !== threadRef.threadId ||
      item.threadId !== threadRef.threadId ||
      item.toolNonExecutionKind ||
      (item.status !== "running" && item.status !== "pending" && item.status !== "waiting")
    )
      return [];
    let fallback: string;
    switch (item.type) {
      case "command_execution":
        fallback = "Running a command";
        break;
      case "dynamic_tool":
        fallback = "Using a tool";
        break;
      case "file_change":
        fallback = "Updating files";
        break;
      case "file_search":
        fallback = "Searching files";
        break;
      case "web_search":
        fallback = "Searching the web";
        break;
      default:
        return [];
    }
    const entry: WorkLogPresentationEntry = {
      id: item.id,
      createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
      label: fallback,
      tone: "tool",
      itemType: item.type,
      toolLifecycleStatus: "inProgress",
      structuredPayload: item,
    };
    const label = (
      workEntryExplicitIntentLabel(entry) ??
      resolveWorkEntryToolPresentation(entry)?.displayName ??
      fallback
    )
      .replace(/\s+/gu, " ")
      .trim();
    return [
      {
        id: item.id,
        label: label.length > 240 ? `${label.slice(0, 239)}…` : label,
        status: item.status,
      },
    ];
  });
}
