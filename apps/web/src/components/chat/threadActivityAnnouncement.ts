import type { RunId } from "@t3tools/contracts";
import type { ThreadActivitySnapshot } from "@t3tools/client-runtime/state/thread-activity-announcement";
import type { TimelineEntry } from "../../session-logic";

export function deliveryFailureSnapshot(
  entries: ReadonlyArray<TimelineEntry>,
  _runId: RunId | null,
) {
  let latestLocalItemOrdinal = -1;
  const deliveryFailures: Array<NonNullable<ThreadActivitySnapshot["deliveryFailures"]>[number]> =
    [];
  for (const entry of entries) {
    const projected =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : "projectedItem" in entry
          ? entry.projectedItem
          : undefined;
    if (projected === undefined || projected.visibility !== "local") continue;
    const item = projected.item;
    latestLocalItemOrdinal = Math.max(latestLocalItemOrdinal, item.ordinal);
    if (
      item.type === "error" &&
      item.status === "failed" &&
      item.failure.class === "transport_error" &&
      (item.id.startsWith("turn-item:steering-delivery-failure:") ||
        item.id.startsWith("turn-item:runtime-request-delivery-failure:"))
    ) {
      deliveryFailures.push({
        id: item.id,
        ordinal: item.ordinal,
        message: `${item.title ?? "Delivery not confirmed"}. ${item.failure.message}`,
      });
    }
  }
  return { deliveryFailures, latestLocalItemOrdinal };
}
