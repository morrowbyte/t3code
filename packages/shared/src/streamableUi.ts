export interface VisualSource {
  label: string;
  url: string;
}

export interface VisualBase {
  id: string;
  sources: VisualSource[];
}

export interface VisualMetric extends VisualBase {
  type: "metric";
  label: string;
  value: string | number;
  detail: string | undefined;
}

export interface VisualTable extends VisualBase {
  type: "table";
  title: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export const CHART_KINDS = [
  "line",
  "area",
  "bar",
  "pie",
  "donut",
  "radar",
  "radial",
  "scatter",
  "composed",
] as const;
export type VisualChartKind = (typeof CHART_KINDS)[number];

export interface VisualChart extends VisualBase {
  type: "chart";
  title: string;
  xLabel: string | undefined;
  yLabel: string | undefined;
  kind: VisualChartKind;
  horizontal?: boolean | undefined;
  stacked?: boolean | undefined;
  maximum?: number | undefined;
  series: Array<{ key: string; label: string; kind?: "line" | "area" | "bar" | undefined }>;
  points: Array<{ label: string; value: number; series?: string; x?: number | undefined }>;
}

export interface VisualFact {
  key: string;
  label: string;
  value: string | number | null;
}

export interface VisualCard {
  key: string;
  title: string;
  value?: string | number | undefined;
  detail?: string | undefined;
  badge?: string | undefined;
  facts: VisualFact[];
}

export interface VisualCards extends VisualBase {
  type: "cards";
  title: string;
  items: VisualCard[];
}

export type VisualStatus = "pending" | "active" | "complete" | "blocked";

export interface VisualStep {
  key: string;
  title: string;
  detail?: string | undefined;
  time?: string | undefined;
  status?: VisualStatus | undefined;
}

export interface VisualTimeline extends VisualBase {
  type: "timeline";
  title: string;
  items: VisualStep[];
}

export interface VisualWorkflow extends VisualBase {
  type: "workflow";
  title: string;
  nodes: Array<VisualStep & { kind?: "start" | "step" | "decision" | "end" | undefined }>;
  edges: Array<{ key: string; from: string; to: string; label?: string | undefined }>;
}

export interface VisualReport extends VisualBase {
  type: "report";
  title: string;
  layout: "tabs" | "details";
  sections: Array<{ key: string; title: string; text?: string | undefined; facts: VisualFact[] }>;
}

export const UML_KINDS = ["sequence", "class", "state", "usecase", "activity"] as const;
export interface VisualUml extends VisualBase {
  type: "uml";
  title: string;
  kind: (typeof UML_KINDS)[number];
  snapshots: Array<{ key: string; source: string }>;
}

export type RichVisualComponent =
  | VisualCards
  | VisualTimeline
  | VisualWorkflow
  | VisualReport
  | VisualUml;
export type VisualComponent = VisualMetric | VisualTable | VisualChart | RichVisualComponent;

export const STREAMABLE_UI_LIMITS = {
  characters: 128_000,
  records: 512,
  components: 24,
  items: 200,
  columns: 12,
  text: 2_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= STREAMABLE_UI_LIMITS.text;
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || isText(value);
}

function isLabel(value: unknown): value is string {
  return isText(value) && value.trim().length > 0 && value.length <= 200;
}

function optionalLabel(value: unknown): value is string | undefined {
  return value === undefined || isLabel(value);
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function optionalStatus(value: unknown): value is VisualStatus | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && ["pending", "active", "complete", "blocked"].includes(value))
  );
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
}

function isCell(value: unknown): value is string | number | null {
  return value === null || isText(value) || isNumber(value);
}

function sourcesFrom(value: unknown): VisualSource[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const sources: VisualSource[] = [];
  for (const source of value) {
    if (
      !isRecord(source) ||
      !onlyKeys(source, ["label", "url"]) ||
      !isLabel(source.label) ||
      !isText(source.url) ||
      // oxlint-disable-next-line eslint/no-control-regex -- URL parsing strips controls; reject them before normalization.
      /[\s\u0000-\u001f\u007f]/.test(source.url)
    ) {
      return undefined;
    }
    try {
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        return undefined;
      }
      sources.push({ label: source.label, url: url.href });
    } catch {
      return undefined;
    }
  }
  return sources;
}

function applyRecord(value: unknown, components: VisualComponent[]): boolean {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string") {
    return false;
  }
  if (!isKey(value.id)) return false;
  const target = components.find((component) => component.id === value.id);
  switch (value.type) {
    case "uml-snapshot": {
      if (
        !onlyKeys(value, ["type", "id", "key", "source"]) ||
        target?.type !== "uml" ||
        !isKey(value.key) ||
        typeof value.source !== "string" ||
        value.source.length < 1 ||
        value.source.length > 16_000 ||
        target.snapshots.length >= 24 ||
        target.snapshots.some((snapshot) => snapshot.key === value.key)
      )
        return false;
      target.snapshots.push({ key: value.key, source: value.source });
      return true;
    }
    case "row": {
      if (
        !onlyKeys(value, ["type", "id", "cells"]) ||
        target?.type !== "table" ||
        target.rows.length >= STREAMABLE_UI_LIMITS.items ||
        !Array.isArray(value.cells) ||
        value.cells.length !== target.columns.length ||
        !value.cells.every(isCell)
      ) {
        return false;
      }
      target.rows.push(value.cells);
      return true;
    }
    case "point": {
      if (
        !onlyKeys(value, ["type", "id", "label", "value", "series", "x"]) ||
        target?.type !== "chart" ||
        target.points.length >= STREAMABLE_UI_LIMITS.items ||
        !isLabel(value.label) ||
        !isNumber(value.value) ||
        (target.kind === "scatter" ? !isNumber(value.x) : value.x !== undefined) ||
        (["pie", "donut", "radar", "radial"].includes(target.kind) && value.value < 0) ||
        (target.maximum !== undefined && value.value > target.maximum) ||
        (value.series === undefined && target.series.length > 0) ||
        (value.series !== undefined &&
          (!target.series.some((series) => series.key === value.series) ||
            target.points.some(
              (point) =>
                point.series === value.series &&
                (target.kind === "scatter" ? point.x === value.x : point.label === value.label),
            )))
      ) {
        return false;
      }
      target.points.push({
        label: value.label,
        value: value.value,
        ...(value.x === undefined ? {} : { x: Number(value.x) }),
        ...(value.series === undefined ? {} : { series: String(value.series) }),
      });
      return true;
    }
    case "series": {
      if (
        !onlyKeys(value, ["type", "id", "key", "label", "kind"]) ||
        target?.type !== "chart" ||
        !isKey(value.key) ||
        !isLabel(value.label) ||
        (value.kind !== undefined &&
          (target.kind !== "composed" || !["line", "bar", "area"].includes(String(value.kind)))) ||
        (["pie", "donut", "radial"].includes(target.kind) && target.series.length > 0) ||
        target.series.length >= 8 ||
        target.points.some((point) => point.series === undefined) ||
        target.series.some((series) => series.key === value.key)
      )
        return false;
      target.series.push({
        key: value.key,
        label: value.label,
        ...(value.kind === undefined ? {} : { kind: value.kind as "line" | "bar" | "area" }),
      });
      return true;
    }
    case "card": {
      if (
        !onlyKeys(value, ["type", "id", "key", "title", "value", "detail", "badge"]) ||
        target?.type !== "cards" ||
        !isKey(value.key) ||
        !isLabel(value.title) ||
        (value.value !== undefined && !isText(value.value) && !isNumber(value.value)) ||
        !optionalText(value.detail) ||
        !optionalLabel(value.badge) ||
        target.items.length >= STREAMABLE_UI_LIMITS.items ||
        target.items.some((item) => item.key === value.key)
      )
        return false;
      target.items.push({
        key: value.key,
        title: value.title,
        value: value.value,
        detail: value.detail,
        badge: value.badge,
        facts: [],
      });
      return true;
    }
    case "event":
    case "node": {
      if (
        !onlyKeys(value, [
          "type",
          "id",
          "key",
          "title",
          "detail",
          "time",
          "status",
          ...(value.type === "node" ? ["kind"] : []),
        ]) ||
        !isKey(value.key) ||
        !isLabel(value.title) ||
        !optionalText(value.detail) ||
        !optionalLabel(value.time) ||
        !optionalStatus(value.status) ||
        (value.kind !== undefined &&
          !["start", "step", "decision", "end"].includes(String(value.kind)))
      )
        return false;
      const items =
        value.type === "event" && target?.type === "timeline"
          ? target.items
          : value.type === "node" && target?.type === "workflow"
            ? target.nodes
            : undefined;
      if (
        !items ||
        items.length >= STREAMABLE_UI_LIMITS.items ||
        items.some((item) => item.key === value.key)
      )
        return false;
      items.push({
        key: value.key,
        title: value.title,
        detail: value.detail,
        time: value.time,
        status: value.status,
        ...(value.kind === undefined
          ? {}
          : { kind: value.kind as "start" | "step" | "decision" | "end" }),
      });
      return true;
    }
    case "edge": {
      if (
        !onlyKeys(value, ["type", "id", "key", "from", "to", "label"]) ||
        target?.type !== "workflow" ||
        !isKey(value.key) ||
        !isKey(value.from) ||
        !isKey(value.to) ||
        value.from === value.to ||
        !optionalLabel(value.label) ||
        target.edges.length >= STREAMABLE_UI_LIMITS.items ||
        target.edges.some((edge) => edge.key === value.key) ||
        !target.nodes.some((node) => node.key === value.from) ||
        !target.nodes.some((node) => node.key === value.to)
      )
        return false;
      target.edges.push({ key: value.key, from: value.from, to: value.to, label: value.label });
      return true;
    }
    case "section": {
      if (
        !onlyKeys(value, ["type", "id", "key", "title", "text"]) ||
        target?.type !== "report" ||
        !isKey(value.key) ||
        !isLabel(value.title) ||
        !optionalText(value.text) ||
        target.sections.length >= 12 ||
        target.sections.some((section) => section.key === value.key)
      )
        return false;
      target.sections.push({ key: value.key, title: value.title, text: value.text, facts: [] });
      return true;
    }
    case "fact": {
      if (
        !onlyKeys(value, ["type", "id", "item", "key", "label", "value"]) ||
        !isKey(value.item) ||
        !isKey(value.key) ||
        !isLabel(value.label) ||
        !isCell(value.value)
      )
        return false;
      const facts =
        target?.type === "cards"
          ? target.items.find((item) => item.key === value.item)?.facts
          : target?.type === "report"
            ? target.sections.find((section) => section.key === value.item)?.facts
            : undefined;
      if (
        !facts ||
        facts.length >= STREAMABLE_UI_LIMITS.items ||
        facts.some((fact) => fact.key === value.key)
      )
        return false;
      facts.push({ key: value.key, label: value.label, value: value.value });
      return true;
    }
    default:
      break;
  }
  if (target || components.length >= STREAMABLE_UI_LIMITS.components) return false;
  const sources = sourcesFrom(value.sources);
  if (!sources) return false;
  switch (value.type) {
    case "uml": {
      if (
        !onlyKeys(value, ["type", "id", "title", "kind", "sources"]) ||
        !isLabel(value.title) ||
        !UML_KINDS.includes(value.kind as VisualUml["kind"])
      )
        return false;
      components.push({
        type: "uml",
        id: value.id,
        title: value.title,
        kind: value.kind as VisualUml["kind"],
        sources,
        snapshots: [],
      });
      return true;
    }
    case "metric":
      if (
        !onlyKeys(value, ["type", "id", "label", "value", "detail", "sources"]) ||
        !isLabel(value.label) ||
        !(isText(value.value) || isNumber(value.value)) ||
        !optionalText(value.detail)
      ) {
        return false;
      }
      components.push({
        type: "metric",
        id: value.id,
        label: value.label,
        value: value.value,
        detail: value.detail,
        sources,
      });
      return true;
    case "table":
      if (
        !onlyKeys(value, ["type", "id", "title", "columns", "sources"]) ||
        !isLabel(value.title) ||
        !Array.isArray(value.columns) ||
        value.columns.length < 1 ||
        value.columns.length > STREAMABLE_UI_LIMITS.columns ||
        !value.columns.every(isLabel)
      ) {
        return false;
      }
      components.push({
        type: "table",
        id: value.id,
        title: value.title,
        columns: value.columns,
        rows: [],
        sources,
      });
      return true;
    case "chart":
      if (
        !onlyKeys(value, [
          "type",
          "id",
          "title",
          "xLabel",
          "yLabel",
          "kind",
          "horizontal",
          "stacked",
          "maximum",
          "sources",
        ]) ||
        !isLabel(value.title) ||
        !optionalLabel(value.xLabel) ||
        !optionalLabel(value.yLabel) ||
        (value.kind !== undefined && !CHART_KINDS.includes(value.kind as VisualChartKind)) ||
        (value.horizontal !== undefined &&
          (typeof value.horizontal !== "boolean" || value.kind !== "bar")) ||
        (value.stacked !== undefined &&
          (typeof value.stacked !== "boolean" || !["bar", "area"].includes(String(value.kind)))) ||
        (value.maximum !== undefined &&
          (!isNumber(value.maximum) ||
            value.maximum <= 0 ||
            !["radar", "radial"].includes(String(value.kind))))
      ) {
        return false;
      }
      components.push({
        type: "chart",
        id: value.id,
        title: value.title,
        xLabel: value.xLabel,
        yLabel: value.yLabel,
        kind: (value.kind ?? "line") as VisualChartKind,
        horizontal: value.horizontal as boolean | undefined,
        stacked: value.stacked as boolean | undefined,
        maximum: value.maximum as number | undefined,
        series: [],
        points: [],
        sources,
      });
      return true;
    case "cards":
    case "timeline":
    case "workflow":
    case "report": {
      if (
        !onlyKeys(value, [
          "type",
          "id",
          "title",
          "sources",
          ...(value.type === "report" ? ["layout"] : []),
        ]) ||
        !isLabel(value.title)
      )
        return false;
      const base = { id: value.id, title: value.title, sources };
      if (value.type === "cards") components.push({ ...base, type: "cards", items: [] });
      if (value.type === "timeline") components.push({ ...base, type: "timeline", items: [] });
      if (value.type === "workflow")
        components.push({ ...base, type: "workflow", nodes: [], edges: [] });
      if (value.type === "report") {
        if (value.layout !== undefined && value.layout !== "tabs" && value.layout !== "details")
          return false;
        components.push({
          ...base,
          type: "report",
          layout: value.layout ?? "details",
          sections: [],
        });
      }
      return true;
    }
    default:
      return false;
  }
}

/** A record commits only after JSON.parse succeeds. Never repair a partial number
 * or string: it could otherwise briefly display a fabricated price or citation.
 */
export function parseStreamableUi(code: string, isStreaming: boolean) {
  const components: VisualComponent[] = [];
  const oversized = code.length > STREAMABLE_UI_LIMITS.characters;
  // Keep the already committed prefix even if the provider exceeds the block budget.
  const bounded = oversized
    ? code.slice(0, Math.max(0, code.lastIndexOf("\n", STREAMABLE_UI_LIMITS.characters)))
    : code;
  const lines = bounded.split("\n");
  let error: string | undefined;
  let records = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    records++;
    if (records > STREAMABLE_UI_LIMITS.records) {
      return { components, pending: false, error: "Visual exceeds the record limit." };
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (isStreaming && index === lines.length - 1) {
        return {
          components,
          pending: error === undefined && !oversized,
          error: oversized ? "Visual exceeds the size limit." : error,
        };
      }
      return { components, pending: false, error: `Invalid visual JSON on line ${index + 1}.` };
    }
    if (!applyRecord(value, components)) {
      error ??= `Unsupported visual record on line ${index + 1}.`;
    }
  }
  return {
    components,
    pending: isStreaming && !oversized && error === undefined,
    error: oversized
      ? "Visual exceeds the size limit."
      : (error ??
        (components.length === 0 && !isStreaming ? "Visual has no components." : undefined)),
  };
}

/** Shared coordinates keep web and native plots on the same categorical domain. */
export function chartGeometry(points: VisualChart["points"]) {
  if (points.length === 0) return undefined;
  const minimum = Math.min(...points.map((point) => point.value));
  const maximum = Math.max(...points.map((point) => point.value));
  const span = maximum - minimum;
  return {
    minimum,
    maximum,
    coordinates: points.map((point, index) => ({
      x: points.length === 1 ? 300 : 52 + (index / (points.length - 1)) * 496,
      y: span === 0 ? 100 : 164 - ((point.value - minimum) / span) * 128,
    })),
  };
}
