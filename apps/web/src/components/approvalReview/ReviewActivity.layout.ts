import type { ReviewBundle, ReviewEdge } from "@t3tools/client-runtime/approvalReview";

export function activityLayout(
  bundle: ReviewBundle,
  expanded: boolean,
): {
  steps: ReviewBundle["steps"];
  edges: readonly ReviewEdge[];
  positions: Map<string, { x: number; y: number; width: number }>;
} {
  const visible = bundle.steps.filter((step) => expanded || step.kind !== "decision");
  const ids = new Set(visible.map((step) => step.id));
  const edges: ReviewEdge[] = [];
  let traversals = 0;
  for (const step of visible) {
    const pending = bundle.edges
      .filter((edge) => edge.from === step.id)
      .map((edge) => ({ edge, visited: new Set<string>() }));
    while (pending.length) {
      if (++traversals > 4096) return activityLayout(bundle, true);
      const { edge, visited } = pending.shift()!;
      if (ids.has(edge.to)) {
        edges.push(edge);
        continue;
      }
      if (visited.has(edge.to)) continue;
      const nextVisited = new Set(visited).add(edge.to);
      for (const next of bundle.edges.filter((candidate) => candidate.from === edge.to)) {
        const label = [edge.label, next.label].filter(Boolean).join(" · ");
        pending.push({
          edge: { from: step.id, to: next.to, ...(label ? { label } : {}) },
          visited: nextVisited,
        });
      }
    }
  }
  // Shared terminal outcomes get a separate lane; source order remains the review's reading order.
  const outcomes = new Set(
    visible
      .filter(
        (step) => step.kind === "end" && edges.filter((edge) => edge.to === step.id).length > 1,
      )
      .map((step) => step.id),
  );
  let sequence = 0;
  let outcome = 0;
  const positions = new Map<string, { x: number; y: number; width: number }>();
  for (const step of visible) {
    if (outcomes.has(step.id)) {
      positions.set(step.id, { x: 700, y: outcome++ * 150, width: 200 });
      continue;
    }
    const index = sequence++;
    const row = Math.floor(index / 2);
    const column = row % 2 === 0 ? index % 2 : 1 - (index % 2);
    positions.set(step.id, { x: column * 360, y: row * 150, width: 300 });
  }
  return { steps: visible, edges, positions };
}
