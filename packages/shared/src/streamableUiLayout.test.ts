import { describe, expect, it } from "vite-plus/test";
import { parseStreamableUi } from "./streamableUi.ts";
import { chartDataModel, chartCsv, workflowLayout } from "./streamableUiLayout.ts";

const parse = (...records: unknown[]) =>
  parseStreamableUi(records.map((record) => JSON.stringify(record)).join("\n"), false).components;

describe("chart data shared by Recharts and native SVG", () => {
  it("compares all series at the same category, keeps missing values empty and uses a signed nice domain", () => {
    const chart = parse(
      { type: "chart", id: "c", title: "Costs", kind: "bar" },
      { type: "series", id: "c", key: "plan", label: "Plan" },
      { type: "series", id: "c", key: "actual", label: "Actual" },
      { type: "point", id: "c", series: "plan", label: "Q1", value: 24 },
      { type: "point", id: "c", series: "actual", label: "Q1", value: 21 },
      { type: "point", id: "c", series: "actual", label: "Q2", value: -8 },
    )[0];
    if (chart?.type !== "chart") throw new Error("Expected chart");
    const model = chartDataModel(chart);
    expect(model.categories).toEqual(["Q1", "Q2"]);
    expect(model.values).toEqual([
      [24, 21],
      [null, -8],
    ]);
    expect(model.domain[0]).toBeLessThanOrEqual(-8);
    expect(model.domain[1]).toBeGreaterThanOrEqual(24);
    expect(model.ticks).toContain(0);
    expect(model.rows[0]).toMatchObject({ _index: 0, s0: 24, s1: 21 });
  });

  it.each([0, -2, 1e12, 0.000001])(
    "keeps a constant series on a nonzero finite axis: %s",
    (value) => {
      const chart = parse(
        { type: "chart", id: "c", title: "Samples" },
        { type: "point", id: "c", label: "Same", value },
        { type: "point", id: "c", label: "Same", value },
      )[0];
      if (chart?.type !== "chart") throw new Error("Expected chart");
      const model = chartDataModel(chart);
      expect(model.categories).toHaveLength(2);
      expect(model.domain[0]).toBeLessThan(value);
      expect(model.domain[1]).toBeGreaterThan(value);
      expect(model.domain.every(Number.isFinite)).toBe(true);
      expect(model.ticks.length).toBeGreaterThan(1);
    },
  );
});

describe("chart CSV", () => {
  it("keeps numeric scatter X values alongside sample labels and series values", () => {
    const chart = parse(
      { type: "chart", id: "s", title: "Latency", kind: "scatter", xLabel: "KB", yLabel: "ms" },
      { type: "point", id: "s", label: "Small", x: 12, value: 8 },
    )[0];
    if (chart?.type !== "chart") throw new Error("Expected chart");
    expect(chartCsv(chart)).toBe("Sample,KB,Value (ms)\r\nSmall,12,8");
  });
  it("exports every arrived series with quoted text, raw signed numbers and empty missing values", () => {
    const chart = parse(
      { type: "chart", id: "c", title: "Costs", xLabel: "Quarter, period", yLabel: "EUR" },
      { type: "series", id: "c", key: "a", label: 'Plan "A"' },
      { type: "series", id: "c", key: "b", label: "Actual" },
      { type: "point", id: "c", series: "a", label: "Q1", value: 24.5 },
      { type: "point", id: "c", series: "b", label: "Q1", value: -8 },
      { type: "point", id: "c", series: "b", label: "Q2, interim", value: 0 },
    )[0];
    if (chart?.type !== "chart") throw new Error("Expected chart");
    expect(chartCsv(chart)).toBe(
      '"Quarter, period","Plan ""A"" (EUR)",Actual (EUR)\r\nQ1,24.5,-8\r\n"Q2, interim",,0',
    );
  });
});

describe("directed workflow layout", () => {
  it("routes branching and cyclic edges to the correct node borders without mutating input", () => {
    const workflow = parse(
      { type: "workflow", id: "f", title: "Review" },
      ...["start", "check", "pilot", "accept", "revise"].map((key) => ({
        type: "node",
        id: "f",
        key,
        title: key,
      })),
      ...[
        ["start", "check"],
        ["check", "pilot"],
        ["pilot", "accept"],
        ["pilot", "revise"],
        ["revise", "check"],
      ].map(([from, to], index) => ({
        type: "edge",
        id: "f",
        key: `e${index}`,
        from,
        to,
        label: `Route ${index}`,
      })),
    )[0];
    if (workflow?.type !== "workflow") throw new Error("Expected workflow");
    const original = JSON.stringify(workflow);
    const layout = workflowLayout(workflow);
    for (const edge of layout.edges) {
      const source = layout.nodes.find((node) => node.key === edge.from)!;
      const target = layout.nodes.find((node) => node.key === edge.to)!;
      const first = edge.points[0]!;
      const last = edge.points.at(-1)!;
      const before = edge.points.at(-2)!;
      const onBorder = (point: { x: number; y: number }, node: typeof source) =>
        Math.abs(point.x - node.x) < 0.001 ||
        Math.abs(point.x - node.x - node.width) < 0.001 ||
        Math.abs(point.y - node.y) < 0.001 ||
        Math.abs(point.y - node.y - node.height) < 0.001;
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
      expect(
        edge.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
      ).toBe(true);
      expect(onBorder(first, source)).toBe(true);
      expect(onBorder(last, target)).toBe(true);
      expect(
        (last.x - before.x) * (target.x + target.width / 2 - last.x) +
          (last.y - before.y) * (target.y + target.height / 2 - last.y),
      ).toBeGreaterThan(0);
    }
    expect(JSON.stringify(workflow)).toBe(original);
    expect(workflowLayout(workflow)).toEqual(layout);
  });
});
