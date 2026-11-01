import type {
  BoatAnalyticsInput,
  BoatInstance,
  BoatUsagePoint,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DAY = 86_400_000;
export const MAX_ANALYTICS_INSTANCES = 8;
export const MAX_USAGE_SAMPLES = 2048;
const MAX_LEASE_SAMPLES = 2048;

export type BoatLeaseSample = {
  readonly at: string;
  readonly threadIds: readonly ThreadId[];
  readonly running: boolean;
};

export function boatUsageRunning(state: string) {
  return ![
    "provisioning",
    "cloning",
    "creating",
    "stopping",
    "archived",
    "stopped",
    "deleting",
    "deleted",
    "error",
  ].includes(state);
}

export function recordBoatLease(timeline: readonly BoatLeaseSample[], sample: BoatLeaseSample) {
  const last = timeline.at(-1);
  if (
    last &&
    last.running === sample.running &&
    last.threadIds.length === sample.threadIds.length &&
    last.threadIds.every((id) => sample.threadIds.includes(id))
  )
    return timeline;
  return [...timeline, sample].slice(-MAX_LEASE_SAMPLES);
}

export function estimateBoatThreadUsage(
  point: BoatUsagePoint,
  timeline: readonly BoatLeaseSample[],
  createdAt: string,
  threadId: ThreadId,
): BoatUsagePoint {
  const start = Math.max(Date.parse(point.since), Date.parse(createdAt));
  const end = Date.parse(point.measuredUntil ?? point.until);
  if (point.seconds === null || point.dollars === null) {
    return { ...point, attribution: "unknown" };
  }
  if (end <= start || (point.seconds === 0 && point.dollars === 0)) {
    return { ...point, seconds: 0, dollars: 0, attribution: "estimated" };
  }
  let previous = timeline.findLast((sample) => Date.parse(sample.at) <= start);
  let cursor = start;
  let runtime = 0;
  let share = 0;
  let unknown = 0;
  for (const next of [
    ...timeline.filter((sample) => Date.parse(sample.at) > start && Date.parse(sample.at) < end),
    null,
  ]) {
    const until = next ? Date.parse(next.at) : end;
    const duration = until - cursor;
    if (!previous) {
      unknown += duration;
      runtime += duration;
    } else if (previous.running) {
      runtime += duration;
      if (previous.threadIds.includes(threadId)) share += duration / previous.threadIds.length;
    }
    cursor = until;
    if (next) previous = next;
  }
  // Unobserved runtime stays unassigned; usage is uniform only within observed running intervals.
  const fraction = runtime > 0 && unknown < end - start ? share / runtime : null;
  return {
    ...point,
    seconds: fraction === null ? null : point.seconds * fraction,
    dollars: fraction === null ? null : point.dollars * fraction,
    attribution: unknown > 0 || fraction === null ? "unknown" : "estimated",
  };
}

export function boatLifecycleCounts(
  timeline: readonly BoatLeaseSample[],
  since: string,
  until: string,
  createdAt: string,
) {
  let starts = 0;
  let stops = 0;
  for (let index = 0; index < timeline.length; index++) {
    const sample = timeline[index]!;
    if (sample.at < since || sample.at >= until) continue;
    const previous = timeline[index - 1];
    if (sample.running && (previous ? !previous.running : sample.at === createdAt)) starts++;
    if (!sample.running && previous?.running) stops++;
  }
  return { starts, stops };
}

export function boatUsageWindows(range: BoatAnalyticsInput["range"], now: number) {
  const current = DateTime.makeUnsafe(now);
  const today = DateTime.toEpochMillis(DateTime.startOf(current, "day"));
  const start =
    range === "day"
      ? today
      : range === "week"
        ? today - 6 * DAY
        : DateTime.toEpochMillis(DateTime.startOf(current, "month"));
  const step = range === "day" ? DAY / 6 : range === "week" ? DAY : 4 * DAY;
  const windows: { since: string; until: string }[] = [];
  for (let cursor = start; cursor < now; cursor += step) {
    windows.push({
      since: DateTime.formatIso(DateTime.makeUnsafe(cursor)),
      until: DateTime.formatIso(DateTime.makeUnsafe(Math.min(cursor + step, now))),
    });
  }
  return {
    since: DateTime.formatIso(DateTime.makeUnsafe(start)),
    until: DateTime.formatIso(current),
    windows,
  };
}

export function boatThreadIds(
  instance: Pick<BoatInstance, "threadId" | "leases"> & {
    readonly usageThreadIds?: readonly ThreadId[];
  },
) {
  return Array.from(
    new Set([
      ...(instance.threadId ? [instance.threadId] : []),
      ...instance.leases,
      ...(instance.usageThreadIds ?? []),
    ]),
  );
}
