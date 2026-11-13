import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";
import { StreamableUi } from "./StreamableUi";

const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const prefix = lines(
  { type: "report", id: "report", title: "Decision", layout: "tabs" },
  { type: "section", id: "report", key: "benefit", title: "Benefits", text: "Faster" },
  { type: "section", id: "report", key: "risk", title: "Risks", text: "Costs" },
  { type: "chart", id: "plot", title: "Forecast", kind: "area" },
  { type: "series", id: "plot", key: "plan", label: "Plan" },
  { type: "point", id: "plot", series: "plan", label: "Day 1", value: 4 },
);

describe("streamable visuals in the browser", () => {
  it("appends committed rows and points while keeping disclosures and sources available", async () => {
    const header = lines(
      { type: "metric", id: "close", label: "Close", value: "$123.45" },
      {
        type: "table",
        id: "prices",
        title: "Daily comparison",
        columns: ["Date", "USD"],
        sources: [{ label: "Price source", url: "https://example.com/prices" }],
      },
      { type: "row", id: "prices", cells: ["Day 1", 123.45] },
      { type: "chart", id: "trend", title: "Daily close", xLabel: "Date", yLabel: "USD" },
      { type: "point", id: "trend", label: "Day 1", value: 123.45 },
    );
    const unfinished = '\n{"type":"row","id":"prices","cells":["Day 2",12';
    await using screen = await render(<StreamableUi code={header + unfinished} isStreaming />);
    const table = screen.container.querySelector("table")!;
    const firstRow = table.querySelector("tbody tr");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
    await expect.element(screen.getByRole("status")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Price source" }))
      .toHaveAttribute("href", "https://example.com/prices");
    await userEvent.click(screen.getByText("View data (1 point)", { exact: true }));
    const disclosure = screen.container.querySelector("details")!;
    expect(disclosure.open).toBe(true);
    const finished =
      header + unfinished + '4.56]}\n{"type":"point","id":"trend","label":"Day 2","value":124.56}';
    await screen.rerender(<StreamableUi code={finished} isStreaming={false} />);
    expect(screen.container.querySelector("table")).toBe(table);
    expect(table.querySelector("tbody tr")).toBe(firstRow);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(table.textContent).toContain("124.56");
    expect(disclosure.open).toBe(true);
    expect(disclosure.querySelectorAll("tbody tr")).toHaveLength(2);
    await expect
      .element(screen.getByText("Receiving visual data…", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("escapes executable-looking content and retains the source of rejected records", async () => {
    const code = lines(
      {
        type: "metric",
        id: "safe",
        label: "Literal text",
        value: '<img src=x onerror="alert(1)">',
      },
      { type: "html", id: "unsafe", html: "<script>alert(1)</script>" },
    );
    await using screen = await render(<StreamableUi code={code} isStreaming={false} />);
    await expect
      .element(screen.getByText('<img src=x onerror="alert(1)">', { exact: true }))
      .toBeVisible();
    expect(screen.container.querySelector("img, script")).toBeNull();
    await userEvent.click(
      screen.getByText("Unsupported visual record on line 2. View source", { exact: true }),
    );
    expect(screen.container.querySelector("pre")?.textContent).toBe(code);
  });

  it("retains tabs, visibility, disclosures and focus as records append or cancel", async () => {
    await using screen = await render(<StreamableUi code={prefix} isStreaming />);
    await userEvent.click(screen.getByRole("tab", { name: "Risks" }));
    await userEvent.click(screen.getByRole("button", { name: "Plan series" }));
    await userEvent.click(screen.getByText("View data (1 point)", { exact: true }));
    const selected = screen.container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    )!;
    const disclosure = screen.container.querySelector("details")!;
    selected.focus();
    const appended =
      prefix +
      "\n" +
      lines(
        { type: "fact", id: "report", item: "risk", key: "cost", label: "Budget", value: "20 EUR" },
        { type: "point", id: "plot", series: "plan", label: "Day 2", value: 8 },
      );
    await screen.rerender(<StreamableUi code={appended + '\n{"type":"section"'} isStreaming />);
    expect(screen.container.querySelector('[role="tab"][aria-selected="true"]')).toBe(selected);
    expect(document.activeElement).toBe(selected);
    expect(disclosure.open).toBe(true);
    await expect
      .element(screen.getByRole("button", { name: "Plan series" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(screen.getByText("20 EUR", { exact: true })).toBeVisible();
    expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(2);
    await screen.rerender(
      <StreamableUi code={appended + '\n{"type":"section"'} isStreaming={false} />,
    );
    await expect
      .element(screen.getByText("Invalid visual JSON on line 9. View source", { exact: true }))
      .toBeVisible();
    expect(document.activeElement).toBe(selected);
    await screen.rerender(<StreamableUi key="history" code={appended} isStreaming={false} />);
    await expect.element(screen.getByRole("tab", { name: "Risks" })).toBeVisible();
    expect(screen.container.querySelector('[role="status"]')).toBeNull();
  });

  it("retains open report sections and polar categories while appending and correcting", async () => {
    const records = [
      { type: "report", id: "result-notes", title: "Notes", layout: "details" },
      { type: "section", id: "result-notes", key: "method", title: "Method", text: "Measured" },
      { type: "chart", id: "result-parts", title: "Parts", kind: "donut" },
      { type: "point", id: "result-parts", label: "A", value: 2 },
    ];
    const code = records.map((record) => JSON.stringify(record)).join("\n");
    await using screen = await render(
      <StreamableUi scope="review/sections" code={code} isStreaming />,
    );
    await userEvent.click(screen.getByText("Method", { exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "A series", exact: true }));
    await userEvent.click(screen.getByText("View data (1 point)", { exact: true }));
    const appended = `${code}\n${JSON.stringify({ type: "point", id: "result-parts", label: "B", value: 3 })}`;
    await screen.rerender(<StreamableUi scope="review/sections" code={appended} isStreaming />);
    await expect
      .element(screen.getByRole("button", { name: "A series", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(screen.getByRole("cell", { name: "B", exact: true })).toBeVisible();
    await screen.rerender(
      <StreamableUi
        key="correction"
        scope="review/sections"
        code={appended.replace('"value":2', '"value":4')}
        isStreaming={false}
      />,
    );
    await expect.element(screen.getByText("Measured", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "A series", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(screen.getByRole("cell", { name: "4", exact: true })).toBeVisible();
  });

  it("retains compatible choices in a followup, resets removed tabs and isolates other threads", async () => {
    const revision = prefix
      .split("\n")
      .map((line) => {
        const record = JSON.parse(line);
        return JSON.stringify({ ...record, id: `result-followup-${record.id}` });
      })
      .join("\n");
    await using screen = await render(
      <StreamableUi
        key="original"
        scope="environment/thread-a"
        code={revision}
        isStreaming={false}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Risks" }));
    await userEvent.click(screen.getByRole("button", { name: "Plan series" }));
    await userEvent.click(screen.getByText("View data (1 point)", { exact: true }));
    const corrected = revision.replace('"value":4', '"value":9');
    await screen.rerender(
      <StreamableUi
        key="followup"
        scope="environment/thread-a"
        code={corrected}
        isStreaming={false}
      />,
    );
    await expect
      .element(screen.getByRole("tab", { name: "Risks" }))
      .toHaveAttribute("aria-selected", "true");
    await expect
      .element(screen.getByRole("button", { name: "Plan series" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(screen.getByRole("cell", { name: "9", exact: true })).toBeVisible();
    expect(screen.container.querySelector("details")?.open).toBe(true);
    await screen.rerender(
      <StreamableUi
        key="compatible-shape"
        scope="environment/thread-a"
        code={corrected.replace('"kind":"area"', '"kind":"bar"')}
        isStreaming={false}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Plan series" }))
      .toHaveAttribute("aria-pressed", "false");
    const removed = corrected
      .split("\n")
      .filter((line) => JSON.parse(line).key !== "risk")
      .join("\n");
    await screen.rerender(
      <StreamableUi
        key="removed-tab"
        scope="environment/thread-a"
        code={removed}
        isStreaming={false}
      />,
    );
    await expect
      .element(screen.getByRole("tab", { name: "Benefits" }))
      .toHaveAttribute("aria-selected", "true");
    await screen.rerender(
      <StreamableUi
        key="other-thread"
        scope="environment/thread-b"
        code={corrected}
        isStreaming={false}
      />,
    );
    await expect
      .element(screen.getByRole("tab", { name: "Benefits" }))
      .toHaveAttribute("aria-selected", "true");
    await expect
      .element(screen.getByRole("button", { name: "Plan series" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.container.querySelector("details")?.open).toBe(false);
  });
});
