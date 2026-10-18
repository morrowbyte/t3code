// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { StreamableUi } from "./StreamableUi";

// Layout is checked in the real Browser panel; these tests keep disclosures
// and interaction state observable while Recharts awaits a measured viewport.
function prepareVisualTest() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

describe("native streamable visuals", () => {
  it("appends real table rows and chart points while keeping data disclosure and sources available", async () => {
    prepareVisualTest();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const header = [
      {
        type: "metric",
        id: "close",
        label: "NVDA close",
        value: "$123.45",
        detail: "Illustrative test data",
      },
      {
        type: "table",
        id: "prices",
        title: "Daily comparison",
        columns: ["Date", "USD"],
        sources: [{ label: "Price source", url: "https://example.com/nvda" }],
      },
      { type: "row", id: "prices", cells: ["Day 1", 123.45] },
      { type: "chart", id: "trend", title: "Daily close", xLabel: "Date", yLabel: "USD" },
      { type: "point", id: "trend", label: "Day 1", value: 123.45 },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const unfinished = '\n{"type":"row","id":"prices","cells":["Day 2",12';
    try {
      await import("./RichChart");
      await act(async () => root.render(<StreamableUi code={header + unfinished} isStreaming />));
      const table = container.querySelector("table")!;
      const firstRow = table.querySelector("tbody tr");
      expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Receiving");
      expect(container.querySelector("a")?.href).toBe("https://example.com/nvda");
      const disclosure = container.querySelector("details")!;
      disclosure.querySelector("summary")!.click();
      expect(disclosure.open).toBe(true);
      expect(disclosure.querySelector("table")?.textContent).toContain("123.45");

      const finished =
        header +
        unfinished +
        '4.56]}\n{"type":"point","id":"trend","label":"Day 2","value":124.56}';
      await act(async () => root.render(<StreamableUi code={finished} isStreaming={false} />));
      expect(container.querySelector("table")).toBe(table);
      expect(table.querySelector("tbody tr")).toBe(firstRow);
      expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(table.textContent).toContain("124.56");
      expect(disclosure.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector("details")).toBe(disclosure);
      expect(disclosure.open).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("escapes executable-looking text and retains readable source for rejected records", async () => {
    prepareVisualTest();
    const container = document.createElement("div");
    const root = createRoot(container);
    const label = '<img src=x onerror="alert(1)">';
    const code = `${JSON.stringify({ type: "metric", id: "safe", label, value: "<script>alert(1)</script>" })}\n{"type":"html","id":"unsafe","html":"<script>alert(1)</script>"}`;
    try {
      await act(async () => root.render(<StreamableUi code={code} isStreaming={false} />));
      expect(container.querySelector("dt")?.textContent).toBe(label);
      expect(container.querySelector("script, img, iframe")).toBeNull();
      expect(container.querySelector("pre")?.textContent).toBe(code);
      expect(container.querySelector("summary")?.textContent).toContain("line 2");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});

const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const prefix = lines(
  { type: "report", id: "report", title: "Decision", layout: "tabs" },
  { type: "section", id: "report", key: "benefit", title: "Benefits", text: "Faster" },
  { type: "section", id: "report", key: "risk", title: "Risks", text: "Costs" },
  { type: "chart", id: "plot", title: "Forecast", kind: "area" },
  { type: "series", id: "plot", key: "plan", label: "Plan" },
  { type: "point", id: "plot", series: "plan", label: "Day 1", value: 4 },
);

describe("rich visual interaction during assistant streaming", () => {
  it("retains tabs, chart visibility, disclosures and focus as records append or cancel; rehydrates content", async () => {
    prepareVisualTest();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<StreamableUi code={prefix} isStreaming />));
      const benefits = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
      benefits.focus();
      await act(async () =>
        benefits.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
      );
      const selected = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
      expect(selected.textContent).toBe("Risks");
      expect(document.activeElement).toBe(selected);
      const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Plan series"]')!;
      await act(async () => toggle.click());
      const disclosure = host.querySelector("details")!;
      disclosure.open = true;
      selected.focus();
      const appended =
        prefix +
        "\n" +
        lines(
          {
            type: "fact",
            id: "report",
            item: "risk",
            key: "cost",
            label: "Budget",
            value: "20 EUR",
          },
          { type: "point", id: "plot", series: "plan", label: "Day 2", value: 8 },
        );
      await act(async () =>
        root.render(<StreamableUi code={appended + '\n{"type":"section"'} isStreaming />),
      );
      expect(host.querySelector('[role="tab"][aria-selected="true"]')).toBe(selected);
      expect(document.activeElement).toBe(selected);
      expect(disclosure.open).toBe(true);
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      expect(host.textContent).toContain("20 EUR");
      expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
      await act(async () =>
        root.render(<StreamableUi code={appended + '\n{"type":"section"'} isStreaming={false} />),
      );
      expect(host.querySelector('[role="status"]')).toBeNull();
      expect(host.textContent).toContain("Invalid visual JSON");
      expect(document.activeElement).toBe(selected);
      await act(async () =>
        root.render(<StreamableUi key="history" code={appended} isStreaming={false} />),
      );
      expect(host.textContent).toContain("20 EUR");
      expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
      expect(host.querySelector('[role="status"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
