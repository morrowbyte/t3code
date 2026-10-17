import type {
  FeatureTimingFact,
  FeatureTimingRecord,
  ProjectFeatureTimingHistory,
} from "@t3tools/contracts";

export function featureAcceptanceText(
  fact: Extract<FeatureTimingFact, { type: "target_accepted" }>,
) {
  return `Accept feature ${fact.featureId} on ${fact.targetId} at version ${fact.version}`;
}

export function unionDuration(intervals: ReadonlyArray<readonly [number, number]>) {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of sorted) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}

export function validateFeatureTimingRecords(records: readonly FeatureTimingRecord[]) {
  const features = new Map<
    string,
    { targets: Set<string>; waits: Set<string>; threads: Set<string> }
  >();
  let previousSequence = -1;
  for (const { fact, sequence } of records) {
    if (sequence <= previousSequence) return false;
    previousSequence = sequence;
    if (fact.type === "registered") {
      if (
        features.has(fact.featureId) ||
        new Set(fact.targets.map((t) => t.id)).size !== fact.targets.length ||
        new Set(fact.threadIds).size !== fact.threadIds.length ||
        (fact.originalEstimate && fact.originalEstimate.minimumMs > fact.originalEstimate.maximumMs)
      )
        return false;
      features.set(fact.featureId, {
        targets: new Set(fact.targets.map((t) => t.id)),
        waits: new Set(),
        threads: new Set(fact.threadIds),
      });
      continue;
    }
    const feature = features.get(fact.featureId);
    if (!feature) return false;
    if (fact.type === "wait_started") {
      if (feature.waits.has(fact.waitId)) return false;
      feature.waits.add(fact.waitId);
    } else if (fact.type === "wait_ended") {
      if (!feature.waits.delete(fact.waitId)) return false;
    } else if (fact.type === "thread_linked") {
      if (feature.threads.has(fact.threadId) || feature.threads.size >= 16) return false;
      feature.threads.add(fact.threadId);
    } else if (
      (fact.type === "target_accepted" || fact.type === "target_reopened") &&
      !feature.targets.has(fact.targetId)
    )
      return false;
  }
  return true;
}

export function projectFeatureTiming(feed: ProjectFeatureTimingHistory) {
  const now = Date.parse(feed.asOf);
  return feed.records.flatMap((registration) => {
    const initial = registration.fact;
    if (initial.type !== "registered") return [];
    const records = feed.records.filter((r) => r.fact.featureId === initial.featureId);
    const threadIds = new Set(initial.threadIds);
    for (const { fact } of records) if (fact.type === "thread_linked") threadIds.add(fact.threadId);
    const observations = feed.observations.filter((o) => threadIds.has(o.threadId));
    const starts = observations.flatMap((o) =>
      o.runs.flatMap((r) => (r.startedAt === null ? [] : [Date.parse(r.startedAt)])),
    );
    const workStartedAt = starts.length ? Math.min(...starts) : null;
    const intakeAt = registration.userEvidence ? Date.parse(registration.userEvidence.at) : null;
    const targets = initial.targets.map((t) => ({
      ...t,
      acceptedVersion: null as string | null,
      acceptedBy: null as "user" | null,
      acceptedAt: null as number | null,
      evidence: null as Extract<FeatureTimingFact, { type: "target_accepted" }>["evidence"] | null,
      source: null as string | null,
      reopened: false,
    }));
    const activeWaits = new Map<string, { start: number; reason: string }>();
    const waits: { start: number; end: number; reason: string }[] = [];
    const phases: { phase: string; start: number; end: number }[] = [];
    let firstAcceptedAt: number | null = null;
    let latestCompletionAt: number | null = null;
    let reopenCount = 0;
    for (const record of records) {
      const { fact } = record;
      const at = Date.parse(record.at);
      if (fact.type === "target_accepted" && record.userEvidence) {
        const target = targets.find((t) => t.id === fact.targetId);
        if (!target) continue;
        const acceptedAt = Date.parse(record.userEvidence.at);
        Object.assign(target, {
          acceptedVersion: fact.version,
          acceptedBy: record.userEvidence.actor,
          acceptedAt,
          evidence: fact.evidence,
          source: record.userEvidence.source,
          reopened: false,
        });
        firstAcceptedAt = Math.min(firstAcceptedAt ?? acceptedAt, acceptedAt);
        if (targets.every((t) => t.acceptedAt !== null && !t.reopened))
          latestCompletionAt = Math.max(...targets.map((t) => t.acceptedAt!));
      } else if (fact.type === "target_reopened") {
        const target = targets.find((t) => t.id === fact.targetId);
        if (target) target.reopened = true;
        reopenCount++;
      } else if (fact.type === "wait_started")
        activeWaits.set(fact.waitId, { start: at, reason: fact.reason });
      else if (fact.type === "wait_ended") {
        const wait = activeWaits.get(fact.waitId);
        if (wait) waits.push({ ...wait, end: at });
        activeWaits.delete(fact.waitId);
      } else if (fact.type === "phase_changed") {
        const previous = phases.at(-1);
        if (previous) previous.end = at;
        phases.push({ phase: fact.phase, start: at, end: now });
      }
    }
    const accepted = targets.every((t) => t.acceptedAt !== null && !t.reopened);
    const end = accepted && latestCompletionAt !== null ? latestCompletionAt : now;
    for (const wait of activeWaits.values()) waits.push({ ...wait, end });
    for (const observation of observations)
      for (const wait of observation.waits)
        waits.push({
          start: Date.parse(wait.start),
          end: wait.end === null ? now : Date.parse(wait.end),
          reason: wait.reason,
        });
    const floor = intakeAt ?? -Infinity;
    const clip = (a: number, b: number): readonly [number, number] => [
      Math.max(floor, a),
      Math.min(end, b),
    ];
    const waitMs = unionDuration(waits.map((w) => clip(w.start, w.end)));
    const waitReasons = [...new Set(waits.map((w) => w.reason))].map((reason) => ({
      reason,
      ms: unionDuration(waits.filter((w) => w.reason === reason).map((w) => clip(w.start, w.end))),
    }));
    return [
      {
        featureId: initial.featureId,
        title: initial.title,
        originalEstimate: initial.originalEstimate,
        registeredAt: registration.at,
        intakeAt,
        workStartedAt,
        elapsedFromIntakeMs: intakeAt === null ? null : Math.max(0, end - intakeAt),
        elapsedFromWorkMs: workStartedAt === null ? null : Math.max(0, end - workStartedAt),
        firstAcceptedAt,
        latestCompletionAt,
        targets,
        reopenCount,
        waitMs,
        waitReasons,
        phases: phases.map((p) => ({ phase: p.phase, ms: unionDuration([clip(p.start, p.end)]) })),
        state: accepted
          ? ("accepted" as const)
          : targets.some((t) => t.reopened)
            ? ("reopened" as const)
            : ("in_development" as const),
        runCount: observations.reduce((sum, o) => sum + o.runs.length, 0),
        records,
        threadIds: [...threadIds],
      },
    ];
  });
}
