import { describe, expect, it } from "vite-plus/test";
import { parseStreamableUi, STREAMABLE_UI_LIMITS } from "./streamableUi.ts";

const records = [
  { type: "chart", id: "trend", title: "Capacity", kind: "bar" },
  { type: "series", id: "trend", key: "a", label: "Plan" },
  { type: "series", id: "trend", key: "b", label: "Actual" },
  { type: "point", id: "trend", series: "a", label: "Monday", value: 3 },
  { type: "point", id: "trend", series: "b", label: "Monday", value: -2 },
  { type: "point", id: "trend", series: "a", label: "Tuesday", value: 0 },
  { type: "cards", id: "options", title: "Options" },
  { type: "card", id: "options", key: "small", title: "Small", value: "20 EUR", badge: "Starter" },
  { type: "fact", id: "options", item: "small", key: "capacity", label: "Capacity", value: 2 },
  { type: "timeline", id: "plan", title: "Plan" },
  { type: "event", id: "plan", key: "pilot", title: "Pilot", status: "active", time: "Week 1" },
  { type: "workflow", id: "flow", title: "Review" },
  { type: "node", id: "flow", key: "start", title: "Start" },
  { type: "node", id: "flow", key: "review", title: "Review" },
  { type: "edge", id: "flow", key: "check", from: "start", to: "review", label: "Ready" },
  { type: "report", id: "report", title: "Decision", layout: "tabs" },
  {
    type: "section",
    id: "report",
    key: "risks",
    title: "Risks",
    text: "Pilot first.\nThen decide.",
  },
  { type: "fact", id: "report", item: "risks", key: "owner", label: "Owner", value: null },
  { type: "uml", id: "sequence", title: "Request", kind: "sequence" },
  {
    type: "uml-snapshot",
    id: "sequence",
    key: "first",
    source: "@startuml\nA -> B: Start\n@enduml",
  },
  {
    type: "uml-snapshot",
    id: "sequence",
    key: "response",
    source: "@startuml\nA -> B: Start\nB --> A: Done\n@enduml",
  },
];
const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n");

describe("rich streamable records", () => {
  it("commits each rich record atomically, retains cancellation and rehydrates the same history", () => {
    for (let index = 0; index < records.length; index++) {
      const prefix = lines(...records.slice(0, index));
      const next = JSON.stringify(records[index]);
      for (const cut of [1, Math.floor(next.length / 2), next.length - 1]) {
        const progressive = parseStreamableUi(`${prefix}\n${next.slice(0, cut)}`, true);
        expect(progressive.error).toBeUndefined();
        expect(progressive.components).toEqual(parseStreamableUi(prefix, true).components);
        const cancelled = parseStreamableUi(`${prefix}\n${next.slice(0, cut)}`, false);
        expect(cancelled.pending).toBe(false);
        expect(cancelled.components).toEqual(progressive.components);
      }
    }
    const complete = parseStreamableUi(lines(...records), false);
    expect(complete.error).toBeUndefined();
    expect(complete.components.map((component) => component.type)).toEqual([
      "chart",
      "cards",
      "timeline",
      "workflow",
      "report",
      "uml",
    ]);
    expect(parseStreamableUi(lines(...records), true).components).toEqual(complete.components);
    expect(parseStreamableUi(lines(...records), false)).toEqual(complete);
  });

  it("skips unsupported records, preserves valid later components and exposes fallback", () => {
    const parsed = parseStreamableUi(
      lines(
        records[0],
        { type: "future-component", id: "new", html: "<script>" },
        ...records.slice(1),
      ),
      false,
    );
    expect(parsed.error).toContain("line 2");
    expect(parsed.components).toEqual(parseStreamableUi(lines(...records), false).components);
  });

  it.each([
    { type: "point", id: "trend", series: "missing", label: "Day", value: 1 },
    { type: "series", id: "trend", key: "a", label: "Duplicate" },
    { type: "card", id: "options", key: "small", title: "Duplicate" },
    { type: "fact", id: "options", item: "missing", key: "a", label: "Label", value: 1 },
    { type: "fact", id: "options", item: "small", key: "capacity", label: "Duplicate", value: 3 },
    { type: "edge", id: "flow", key: "bad", from: "start", to: "absent" },
    { type: "edge", id: "flow", key: "bad", from: "start", to: "start" },
    { type: "event", id: "plan", key: "bad", title: "Bad", status: "running-script" },
    { type: "event", id: "plan", key: "bad", title: "Bad", status: ["complete"] },
    { type: "point", id: "trend", series: "a", label: "Monday", value: 99 },
    { type: "section", id: "report", key: "bad", title: "Bad", onClick: "alert(1)" },
    { type: "section", id: "report", key: "bad", title: "Bad", text: "x".repeat(2001) },
  ])(
    "rejects invalid references, duplicate keys and unbounded or executable payloads: %j",
    (record) => {
      const prefix = parseStreamableUi(lines(...records), false);
      const result = parseStreamableUi(lines(...records, record), false);
      expect(result.error).toBeDefined();
      expect(result.components).toEqual(prefix.components);
    },
  );

  it("retains committed components when a later record exceeds the character budget", () => {
    const code = lines(...records);
    const result = parseStreamableUi(
      `${code}\n${"x".repeat(STREAMABLE_UI_LIMITS.characters)}`,
      true,
    );
    expect(result.error).toContain("size limit");
    expect(result.components).toEqual(parseStreamableUi(code, false).components);
    expect(result.pending).toBe(false);
  });

  it("bounds series and report sections independently of the global record budget", () => {
    const series = Array.from({ length: 9 }, (_, index) => ({
      type: "series",
      id: "trend",
      key: `s${index}`,
      label: `Series ${index}`,
    }));
    const parsed = parseStreamableUi(lines(records[0], ...series), false);
    expect(parsed.error).toBeDefined();
    expect(parsed.components[0]).toMatchObject({
      series: series.slice(0, 8).map(({ key, label }) => ({ key, label })),
    });
    const sections = Array.from({ length: 13 }, (_, index) => ({
      type: "section",
      id: "report",
      key: `s${index}`,
      title: `Section ${index}`,
    }));
    expect(parseStreamableUi(lines(records[15], ...sections), false).error).toBeDefined();
  });
});
