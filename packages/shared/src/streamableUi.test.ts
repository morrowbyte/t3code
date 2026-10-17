import { describe, expect, it } from "vite-plus/test";
import { chartGeometry, parseStreamableUi, STREAMABLE_UI_LIMITS } from "./streamableUi.ts";

const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("shared bounded streamable UI", () => {
  it("accepts domain-independent numeric and text metrics with only explicit sources", () => {
    const sources = [{ label: "Measurements", url: "https://example.com/measurements" }];
    const result = parseStreamableUi(
      lines(
        {
          type: "metric",
          id: "temperature",
          label: "Temperature",
          value: -12.75,
          detail: "°C",
          sources,
        },
        { type: "metric", id: "state", label: "State", value: "Ready" },
      ),
      false,
    );
    expect(result.error).toBeUndefined();
    expect(result.components).toMatchObject([
      { type: "metric", value: -12.75, detail: "°C", sources },
      { type: "metric", value: "Ready", sources: [] },
    ]);
  });

  it("retains exactly the bounded completed chart after overflow or cancellation", () => {
    const chart = { type: "chart", id: "readings", title: "Readings" };
    const point = { type: "point", id: "readings", label: "Sample", value: -1e12 };
    const prefix = lines(chart, ...Array.from({ length: STREAMABLE_UI_LIMITS.items }, () => point));
    const overflow = parseStreamableUi(`${prefix}\n${JSON.stringify(point)}`, false);
    const cancelled = parseStreamableUi(
      `${prefix}\n{"type":"point","id":"readings","value":9`,
      false,
    );
    expect(overflow.error).toBeDefined();
    expect(cancelled.pending).toBe(false);
    expect(cancelled.components).toEqual(overflow.components);
    const component = cancelled.components[0];
    expect(component?.type).toBe("chart");
    if (component?.type !== "chart") return;
    expect(component.points).toHaveLength(STREAMABLE_UI_LIMITS.items);
    expect(chartGeometry(component.points)?.coordinates.every((point) => point.y === 100)).toBe(
      true,
    );
  });

  it.each([
    {
      type: "metric",
      id: "long",
      label: "Label",
      value: "x".repeat(STREAMABLE_UI_LIMITS.text + 1),
    },
    {
      type: "table",
      id: "wide",
      title: "Wide",
      columns: Array.from({ length: STREAMABLE_UI_LIMITS.columns + 1 }, () => "Column"),
    },
    {
      type: "metric",
      id: "sources",
      label: "Sources",
      value: 1,
      sources: Array.from({ length: 9 }, () => ({ label: "Source", url: "https://example.com" })),
    },
    {
      type: "metric",
      id: "unsafe",
      label: "Sources",
      value: 1,
      sources: [{ label: "Source", url: "intent://example.com" }],
    },
  ])("shares the original field bounds and safe source policy: %j", (record) => {
    const result = parseStreamableUi(lines(record), false);
    expect(result.components).toEqual([]);
    expect(result.error).toBeDefined();
  });
});
