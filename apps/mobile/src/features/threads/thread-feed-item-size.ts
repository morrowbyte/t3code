import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { notificationChildThreadId } from "@t3tools/client-runtime/state/thread-execution";

export function resolveThreadWorkRowFixedItemSize(
  item: OrchestrationV2TurnItem,
  rowHeight: number | undefined,
): number | undefined {
  // Tool titles and complete short thoughts can wrap; native layout owns their height.
  return item.type === "command_execution" ||
    item.type === "dynamic_tool" ||
    item.type === "reasoning" ||
    (item.type === "notification" && notificationChildThreadId(item.source) !== undefined)
    ? undefined
    : rowHeight;
}

// Content-driven rows must be measured by LegendList: returning a fixed size
// makes the list skip native measurement entirely.
const TURN_FOLD_HEIGHT = 42;

export function resolveThreadFeedFixedItemSize(
  entryType: ThreadFeedEntry["type"],
): number | undefined {
  switch (entryType) {
    case "run-fold":
      return TURN_FOLD_HEIGHT;
    case "work-toggle":
    case "activity-group":
    case "message":
      return undefined;
  }
}
