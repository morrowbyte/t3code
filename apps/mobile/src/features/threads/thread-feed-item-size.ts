import { THREAD_WORK_ROW_MIN_HEIGHT } from "../../lib/layout";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { notificationChildThreadId } from "@t3tools/client-runtime/state/thread-execution";

export function resolveThreadWorkRowFixedItemSize(
  item: OrchestrationV2TurnItem,
  rowHeight: number | undefined,
): number | undefined {
  return item.type === "notification" && notificationChildThreadId(item.source) !== undefined
    ? undefined
    : rowHeight;
}

// Content-driven rows must be measured by LegendList: returning a fixed size
// makes the list skip native measurement entirely.
const TURN_FOLD_HEIGHT = 42;
const WORK_GROUP_TOGGLE_HEIGHT = THREAD_WORK_ROW_MIN_HEIGHT;

export function resolveThreadFeedFixedItemSize(
  entryType: ThreadFeedEntry["type"],
): number | undefined {
  switch (entryType) {
    case "run-fold":
      return TURN_FOLD_HEIGHT;
    case "work-toggle":
      return WORK_GROUP_TOGGLE_HEIGHT;
    case "activity-group":
    case "message":
      return undefined;
  }
}
