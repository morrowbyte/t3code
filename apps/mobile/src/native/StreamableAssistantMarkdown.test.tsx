// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

// Host adapters exercise the real native component's streaming and disclosure logic;
// layout, gestures, SVG drawing and screen-reader behavior still require a device.
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { expanded: boolean };
    onPress?: () => void;
  }) => (
    <button
      aria-label={accessibilityLabel}
      role={accessibilityRole}
      aria-expanded={accessibilityState?.expanded}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  Linking: { openURL: vi.fn() },
}));
vi.mock("../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <span aria-label={accessibilityLabel}>{children}</span>,
}));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({ color: "currentColor" }) }));
vi.mock("react-native-svg", () => ({
  default: ({ children }: { children?: ReactNode }) => <svg>{children}</svg>,
  G: ({ children }: { children?: ReactNode }) => <g>{children}</g>,
  Text: ({ children }: { children?: ReactNode }) => <text>{children}</text>,
  Circle: ({ cx, cy }: { cx: number; cy: number }) => <circle cx={cx} cy={cy} />,
  Path: () => <path />,
  Polyline: ({ points }: { points: string }) => <polyline points={points} />,
}));
vi.mock("./SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({ markdown }: { markdown: string }) => (
    <pre data-markdown="">{markdown}</pre>
  ),
}));

import { StreamableAssistantMarkdown } from "./StreamableAssistantMarkdown";

const textStyle: NativeMarkdownTextStyle = {
  color: "black",
  strongColor: "black",
  mutedColor: "grey",
  linkColor: "blue",
  inlineCodeColor: "black",
  codeColor: "black",
  codeBackgroundColor: "white",
  codeBlockBackgroundColor: "white",
  fileTextColor: "black",
  skillTextColor: "black",
  quoteMarkerColor: "grey",
  dividerColor: "grey",
  fontSize: 16,
  lineHeight: 24,
  fontFamily: "sans-serif",
  headingFontFamily: "sans-serif",
  boldFontFamily: "sans-serif",
};
const records = [
  { type: "metric", id: "depth", label: "Queue depth", value: 42, detail: "jobs" },
  {
    type: "table",
    id: "samples",
    title: "Measurements",
    columns: ["Sample", "Reading", "Note"],
    sources: [{ label: "Measurement source", url: "https://example.com/readings" }],
  },
  { type: "row", id: "samples", cells: ["A", -2.5, null] },
  { type: "chart", id: "trend", title: "Temperature trend", xLabel: "Sample", yLabel: "°C" },
  { type: "point", id: "trend", label: "A", value: -2.5 },
]
  .map((record) => JSON.stringify(record))
  .join("\n");
const prefix = `Before **visual**.\n\n\`\`\`t3-ui\n${records}`;
const partial = '\n{"type":"point","id":"trend","label":"B","value":9';
let root: Root | undefined;
let host: HTMLDivElement;
const onLinkPress = vi.fn();

function render(markdown: string, isStreaming: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <StreamableAssistantMarkdown
        markdown={markdown}
        isStreaming={isStreaming}
        textStyle={textStyle}
        onLinkPress={onLinkPress}
      />,
    ),
  );
}
function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  expect(button).toBeDefined();
  act(() => button!.click());
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("native assistant streaming visuals", () => {
  it("shows completed generic metrics, rows, points and sources before the fence closes", () => {
    render(prefix + partial, true);
    expect(host.textContent).toContain("Queue depth42jobs");
    expect(host.querySelector('[aria-label="Reading: -2.5"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Note: —"]')).not.toBeNull();
    expect(host.querySelectorAll("circle")).toHaveLength(1);
    expect(host.querySelector("circle")?.getAttribute("cx")).toBe("300");
    expect(host.textContent).toContain("Receiving visual data…");
    expect(host.textContent).not.toContain('"value":9');
    click("Measurement source");
    expect(onLinkPress).toHaveBeenCalledWith("https://example.com/readings");
    click("View data");
    expect(host.querySelector('[aria-label="Temperature trend data"]')?.textContent).toContain(
      "A-2.5",
    );
    const firstCircle = host.querySelector("circle");
    const firstCell = host.querySelector('[aria-label="Reading: -2.5"]');
    render(prefix + partial + ".75}\n```\n\nRemaining **Markdown**", true);
    expect(host.textContent).not.toContain("Receiving visual data…");
    expect(host.textContent).toContain("Hide data (2 points)");
    expect(host.querySelectorAll("circle")).toHaveLength(2);
    expect(host.querySelector("circle")).toBe(firstCircle);
    expect(host.querySelector('[aria-label="Reading: -2.5"]')).toBe(firstCell);
    expect(host.querySelector('[aria-label="Temperature trend data"]')?.textContent).toContain(
      "B9.75",
    );
    expect([...host.querySelectorAll("[data-markdown]")].map((node) => node.textContent)).toEqual([
      "Before **visual**.\n\n",
      "\n\nRemaining **Markdown**",
    ]);
    click("Hide data");
    expect(host.querySelector('[aria-label="Temperature trend data"]')).toBeNull();
  });

  it("preserves completed data and an open disclosure on cancellation without a stuck receiving status", () => {
    render(prefix + partial, true);
    click("View data");
    render(prefix + partial, false);
    expect(host.textContent).not.toContain("Receiving visual data…");
    expect(host.textContent).toContain("Invalid visual JSON on line 6.");
    expect(host.textContent).toContain("Queue depth42jobs");
    expect(host.querySelectorAll("circle")).toHaveLength(1);
    expect(host.querySelector('[aria-label="Temperature trend data"]')?.textContent).toContain(
      "A-2.5",
    );
    expect(host.querySelector('[aria-label="Temperature trend data"]')?.textContent).not.toContain(
      "B",
    );
    click("View source");
    expect(host.textContent).toContain(partial);
    click("Hide source");
    expect(host.textContent).not.toContain(partial);
  });

  it("keeps executable-looking values literal and never exposes rejected sources or records", () => {
    const label = '<img src=x onerror="alert(1)">';
    const value = "<script>alert(1)</script>";
    const safe = JSON.stringify({ type: "metric", id: "literal", label, value });
    const unsafe = JSON.stringify({
      type: "metric",
      id: "bad",
      label: "Unsafe",
      value: 1,
      sources: [{ label: "Bad source", url: "javascript:alert(1)" }],
    });
    render(`\`\`\`t3-ui\n${safe}\n${unsafe}\n\`\`\``, false);
    expect(host.textContent).toContain(label + value);
    expect(host.querySelector("script, img, iframe")).toBeNull();
    expect(host.querySelector('[role="link"]')).toBeNull();
    expect(host.textContent).toContain("Unsupported visual record on line 2.");
  });

  it("passes ordinary Markdown and code unchanged through the existing native renderer", () => {
    const markdown =
      '**Text**\n\n```json\n{"type":"metric","note":"t3-ui"}\n```\n\n[Source](https://example.com)';
    render(markdown, true);
    expect(host.querySelector("[data-markdown]")?.textContent).toBe(markdown);
    expect(host.querySelector("svg")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });
});
