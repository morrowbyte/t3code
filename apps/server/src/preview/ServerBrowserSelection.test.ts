import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { inspectAtPoint } from "./ServerBrowserPage.ts";

type Page = Parameters<typeof inspectAtPoint>[0];
const element = (label: string) => {
  const ownerDocument = { querySelectorAll: (_selector: string) => ({ length: 1 }) };
  return {
    id: "save",
    tagName: "BUTTON",
    outerHTML: `<button id="save">${label}</button>`,
    parentElement: null,
    children: [],
    clientLeft: 0,
    clientTop: 0,
    ownerDocument,
    getRootNode: (): object => ownerDocument,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 40, height: 25 }),
  };
};
type Node = ReturnType<typeof element>;

// Playwright invokes function arguments with the handle. Strings are expressions, not callbacks.
function evaluate(expression: string | ((node: never) => unknown), node: Node) {
  const value = NodeVM.runInNewContext(
    typeof expression === "function" ? `(${expression.toString()})(node)` : expression,
    {
      node,
      CSS: { escape: (value: string) => value },
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
    },
  );
  return typeof value === "function" ? undefined : value;
}
function handle(node: Node | null, child: object | null = null) {
  const dispose = vi.fn(async () => {});
  const evaluateNode = vi.fn(async (expression: string | ((node: never) => unknown)) =>
    evaluate(expression, node!),
  );
  return {
    asElement: () =>
      node
        ? {
            contentFrame: async () => child,
            evaluate: evaluateNode,
            boundingBox: async () => ({ x: 100, y: 50, width: 300, height: 200 }),
          }
        : null,
    evaluateNode,
    dispose,
  };
}
function frame(node: Node | null) {
  const selected = handle(node);
  const evaluateHandle = vi.fn(async (script: string) => {
    NodeVM.runInNewContext(script, { document: { elementFromPoint: () => node } });
    return selected;
  });
  return { evaluateHandle, selected, url: () => "http://app.test/demo" };
}
function page(main: object): Page {
  return {
    mainFrame: () => main,
    url: () => "http://app.test/demo",
    title: async () => "Demo",
  } as unknown as Page;
}

describe("server browser element inspection", () => {
  it("invokes a real ElementHandle callback and reads current content without clicking", async () => {
    const node = element("Before");
    const main = frame(node);
    const first = await inspectAtPoint(page(main), 15, 25);
    expect(first).toMatchObject({
      comment: "",
      screenshot: null,
      elements: [
        {
          element: { selector: "#save", htmlPreview: node.outerHTML },
          rect: { x: 10, y: 20, width: 40, height: 25 },
        },
      ],
    });
    expect(typeof main.selected.evaluateNode.mock.calls[0]?.[0]).toBe("function");
    node.outerHTML = '<button id="save">After</button>';
    expect((await inspectAtPoint(page(main), 15, 25))?.elements[0]?.element.htmlPreview).toContain(
      "After",
    );
    expect(main.selected.dispose).toHaveBeenCalledTimes(2);
  });
  it("does not claim a document selector for a shadow-root target", async () => {
    const node = element("Nested");
    node.getRootNode = () => ({});
    expect(
      (await inspectAtPoint(page(frame(node)), 15, 25))?.elements[0]?.element.selector,
    ).toBeNull();
  });
  it("does not publish an ambiguous selector", async () => {
    const node = element("Duplicate id");
    node.ownerDocument.querySelectorAll = () => ({ length: 2 });
    expect(
      (await inspectAtPoint(page(frame(node)), 15, 25))?.elements[0]?.element.selector,
    ).toBeNull();
  });
  it("invokes the iframe border callback and translates frame points and rectangles", async () => {
    const child = frame(element("Nested"));
    const iframe = { ...element("Frame"), clientLeft: 2, clientTop: 3 };
    const selected = handle(iframe, child);
    const main = { evaluateHandle: async () => selected };
    const result = await inspectAtPoint(page(main), 118, 80);
    expect(typeof selected.evaluateNode.mock.calls[0]?.[0]).toBe("function");
    expect(child.evaluateHandle.mock.calls[0]?.[0]).toContain("elementFromPoint(16, 27)");
    expect(result?.elements[0]?.rect).toEqual({ x: 112, y: 73, width: 40, height: 25 });
    expect(selected.dispose).toHaveBeenCalledOnce();
    expect(child.selected.dispose).toHaveBeenCalledOnce();
  });
  it("returns no selection for an empty point and disposes its handle", async () => {
    const main = frame(null);
    expect(await inspectAtPoint(page(main), 0, 0)).toBeNull();
    expect(main.selected.dispose).toHaveBeenCalledOnce();
  });
});
