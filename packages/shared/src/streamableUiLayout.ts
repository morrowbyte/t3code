import dagre from "@dagrejs/dagre";
import { scaleLinear } from "d3-scale";
import type { VisualChart, VisualWorkflow } from "./streamableUi.ts";

export function chartDataModel(chart: VisualChart) {
  const grouped = chart.series.length > 0;
  const series = grouped ? chart.series : [{ key: "", label: "Value" }];
  const categoryKeys =
    chart.kind === "scatter"
      ? grouped
        ? [...new Set(chart.points.map((point) => point.x!))]
        : chart.points.map((point) => point.x!)
      : [];
  const categories =
    chart.kind === "scatter" && grouped
      ? categoryKeys.map((x) => chart.points.find((point) => point.x === x)!.label)
      : grouped
        ? [...new Set(chart.points.map((point) => point.label))]
        : chart.points.map((point) => point.label);
  const values = categories.map(() => series.map((): number | null => null));
  chart.points.forEach((point, index) => {
    const category =
      chart.kind === "scatter" && grouped
        ? categoryKeys.indexOf(point.x!)
        : grouped
          ? categories.indexOf(point.label)
          : index;
    const seriesIndex = grouped ? series.findIndex((item) => item.key === point.series) : 0;
    if (category >= 0 && seriesIndex >= 0) values[category]![seriesIndex] = point.value;
  });
  let minimum = Math.min(...chart.points.map((point) => point.value));
  let maximum = Math.max(...chart.points.map((point) => point.value));
  if (chart.points.length === 0) {
    minimum = 0;
    maximum = 1;
  }
  if (chart.stacked) {
    minimum = Math.min(
      0,
      ...values.map((row) => row.reduce<number>((sum, value) => sum + Math.min(0, value ?? 0), 0)),
    );
    maximum = Math.max(
      0,
      ...values.map((row) => row.reduce<number>((sum, value) => sum + Math.max(0, value ?? 0), 0)),
    );
  }
  if (chart.maximum !== undefined) maximum = chart.maximum;
  if (
    chart.kind !== "line" &&
    chart.kind !== "scatter" &&
    !(
      chart.kind === "composed" &&
      !chart.series.some((series) => series.kind === "bar" || series.kind === "area")
    )
  ) {
    minimum = Math.min(0, minimum);
    maximum = Math.max(0, maximum);
  }
  if (minimum === maximum) {
    const padding = Math.max(Math.abs(minimum) * 0.05, 1);
    minimum -= padding;
    maximum += padding;
  }
  const scale = scaleLinear().domain([minimum, maximum]);
  if (chart.maximum === undefined) scale.nice(4);
  const domain: [number, number] = [scale.domain()[0]!, scale.domain()[1]!];
  return {
    categories,
    xValues: categoryKeys,
    series,
    values,
    domain,
    ticks: scale.ticks(4),
    rows: categories.map((label, index) => ({
      _index: index,
      x: categoryKeys[index] ?? index,
      label,
      ...Object.fromEntries(values[index]!.map((value, seriesIndex) => [`s${seriesIndex}`, value])),
    })),
  };
}

export function chartCsv(chart: VisualChart) {
  const model = chartDataModel(chart);
  const text = (value: string | number | null) => {
    if (value === null) return "";
    if (typeof value === "number") return String(value);
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  };
  const headers = [
    chart.kind === "scatter" ? "Sample" : (chart.xLabel ?? "Category"),
    ...(chart.kind === "scatter" ? [chart.xLabel ?? "X"] : []),
    ...model.series.map((series) =>
      chart.yLabel ? `${series.label} (${chart.yLabel})` : series.label,
    ),
  ];
  return [
    headers,
    ...model.categories.map((category, index) => [
      category,
      ...(chart.kind === "scatter" ? [model.xValues[index]!] : []),
      ...model.values[index]!,
    ]),
  ]
    .map((row) => row.map(text).join(","))
    .join("\r\n");
}

export function formatChartTick(value: number) {
  return new Intl.NumberFormat("en", {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumSignificantDigits: 4,
  }).format(value);
}

export function workflowLayout(
  workflow: VisualWorkflow,
  textScale = 1,
  nodeSizes?: ReadonlyMap<string, { width: number; height: number }>,
) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: "TB",
    nodesep: 28 * textScale,
    ranksep: 32 * textScale,
    marginx: 16 * textScale,
    marginy: 16 * textScale,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  workflow.nodes.forEach((node) =>
    graph.setNode(node.key, {
      ...(nodeSizes?.get(node.key) ?? { width: 184 * textScale, height: 80 * textScale }),
    }),
  );
  workflow.edges.forEach((edge) =>
    graph.setEdge(
      edge.from,
      edge.to,
      {
        width: edge.label ? Math.min(180, edge.label.length * 7 + 16) * textScale : 0,
        height: edge.label ? 24 * textScale : 0,
      },
      edge.key,
    ),
  );
  dagre.layout(graph);
  const nodes = workflow.nodes.map((node, index) => {
    const layout = graph.node(node.key);
    return {
      ...node,
      index: index + 1,
      x: layout.x - layout.width / 2,
      y: layout.y - layout.height / 2,
      width: layout.width,
      height: layout.height,
    };
  });
  const edges = workflow.edges.map((edge) => {
    const layout = graph.edge({ v: edge.from, w: edge.to, name: edge.key });
    return { ...edge, points: layout.points, labelX: layout.x, labelY: layout.y };
  });
  return { nodes, edges, width: graph.graph().width ?? 1, height: graph.graph().height ?? 1 };
}

export function routedEdgePath(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
}
