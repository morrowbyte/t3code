import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { inspectAtPoint as nativeInspectAtPoint } from "./ServerBrowserPage.ts";

type Page = Parameters<typeof nativeInspectAtPoint>[0];
type Cdp = Parameters<typeof nativeInspectAtPoint>[3];
const element = (label: string) => {
  const ownerDocument = { querySelectorAll: (_selector: string) => ({ length: 1 }) };
  const node = {
    id: "save",
    tagName: "BUTTON",
    outerHTML: `<button id="save">${label}</button>`,
    parentElement: null,
    children: [] as Array<object>,
    isContentEditable: false,
    masked: false,
    textContent: label,
    cloneNode: (): object => ({ ...node }),
    clientLeft: 0,
    clientTop: 0,
    ownerDocument,
    getRootNode: (): object => ownerDocument,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 40, height: 25 }),
  };
  return node;
};
type Node = ReturnType<typeof element>;

// Minimal tree fixture for clone/textContent semantics; evaluation still uses native callback rules.
function treeElement(tag: string, parts: Array<string | Node>, masked = false): Node {
  const node = element("");
  node.tagName = tag.toUpperCase();
  node.isContentEditable = masked;
  node.masked = masked;
  Object.defineProperties(node, {
    children: { get: () => parts.filter((part) => typeof part !== "string") },
    textContent: {
      get: () => parts.map((part) => (typeof part === "string" ? part : part.textContent)).join(""),
      set: (value: string) => {
        parts = [value];
      },
    },
    outerHTML: {
      get: () =>
        `<${tag}${masked ? ' contenteditable="true" style="-webkit-text-security: disc;"' : ""}>${parts.map((part) => (typeof part === "string" ? part : part.outerHTML)).join("")}${tag === "br" ? "" : `</${tag}>`}`,
    },
  });
  node.cloneNode = () =>
    treeElement(
      tag,
      parts.map((part) => (typeof part === "string" ? part : (part.cloneNode() as Node))),
      masked,
    );
  return node;
}

// Playwright invokes function arguments with the handle. Strings are expressions, not callbacks.
function evaluate(
  expression: string | ((node: never, arg: never) => unknown),
  node: Node,
  arg?: unknown,
) {
  const value = NodeVM.runInNewContext(
    typeof expression === "function" ? `(${expression.toString()})(node, arg)` : expression,
    {
      node,
      arg,
      CSS: { escape: (value: string) => value },
      getComputedStyle: (node: Node) => ({ getPropertyValue: () => (node.masked ? "disc" : "") }),
    },
  );
  return typeof value === "function" ? undefined : value;
}
function handle(node: Node | null, child: object | null = null) {
  const dispose = vi.fn(async () => {});
  const evaluateNode = vi.fn(
    async (expression: string | ((node: never, arg: never) => unknown), arg?: unknown) =>
      evaluate(expression, node!, arg),
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
function frame(node: Node | null, fields: Array<object> = []) {
  const selected = handle(node);
  const evaluateHandle = vi.fn(async (script: string) => {
    NodeVM.runInNewContext(script, { document: { elementFromPoint: () => node } });
    return selected;
  });
  return { fields, evaluateHandle, selected, url: () => "http://app.test/demo" };
}
function page(main: object): Page & { cdp: Cdp } {
  const cdp = {
    send: async (method: string, input: { expression?: string }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: NodeVM.runInNewContext(input.expression!, {
              document: { querySelectorAll: () => ("fields" in main ? main.fields : []) },
              getComputedStyle: (node: { masked?: boolean }) => ({
                getPropertyValue: () => (node.masked ? "disc" : "none"),
              }),
            }),
          },
        };
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  } as unknown as Cdp;
  return {
    cdp,
    frames: () => [main],
    mainFrame: () => main,
    url: () => "http://app.test/demo",
    title: async () => "Demo",
  } as unknown as Page & { cdp: Cdp };
}

const inspectAtPoint = (page: Page & { cdp: Cdp }, x: number, y: number) =>
  nativeInspectAtPoint(page, x, y, page.cdp);

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
  it.each(["input", "textarea", "editable"])(
    "redacts selected or descendant %s masked values, including serialized HTML copies",
    async (kind) => {
      const secret = 's<&"ecret';
      const encoded = "s&lt;&amp;&quot;ecret";
      const node = element("Form");
      node.outerHTML = `<form><label>Email</label><input name="email" value="normal@example.test"><${kind} type="password" value="${encoded}">${encoded}</${kind}><span>${encoded}</span><script>${secret}</script></form>`;
      const main = frame(node, [
        {
          localName: kind === "editable" ? "div" : kind,
          type: kind === "input" ? "password" : "text",
          isContentEditable: kind === "editable",
          masked: kind !== "input",
          value: secret,
          defaultValue: secret,
          textContent: secret,
        },
      ]);
      const html = (await inspectAtPoint(page(main), 15, 25))?.elements[0]?.element.htmlPreview;
      expect(html).not.toContain(secret);
      expect(html).not.toContain(encoded);
      expect(html).toContain("••••••••");
      expect(html).toContain('<input name="email" value="normal@example.test">');
      expect(html).toContain("<label>Email</label>");
    },
  );
  it.each(["editable", "ancestor"])(
    "structurally redacts a masked subtree when selecting its %s without changing the live DOM",
    async (selection) => {
      const protectedNode = treeElement(
        "div",
        selection === "editable"
          ? ["secret", treeElement("br", []), "value"]
          : [
              treeElement("span", ["sec"]),
              "ret",
              treeElement("br", []),
              "va",
              treeElement("span", [treeElement("b", ["lue"])]),
            ],
        true,
      );
      const normal = treeElement("p", [
        "Normal ",
        treeElement("em", ["formatted"]),
        treeElement("br", []),
        "text",
      ]);
      const node =
        selection === "editable"
          ? protectedNode
          : treeElement("section", [normal, protectedNode, treeElement("output", ["secretvalue"])]);
      const original = node.outerHTML;
      const main = frame(node, [protectedNode]);
      const html = (await inspectAtPoint(page(main), 15, 25))?.elements[0]?.element.htmlPreview;
      expect(html).toContain(
        '<div contenteditable="true" style="-webkit-text-security: disc;">••••••••</div>',
      );
      expect(html).not.toContain("secret");
      expect(html).not.toContain("value");
      if (selection === "ancestor") {
        expect(html).toContain(normal.outerHTML);
        expect(html).toContain("<output>••••••••</output>");
      }
      expect(node.outerHTML).toBe(original);
      expect(protectedNode.textContent).toBe("secretvalue");
    },
  );
  it("redacts a selected password field's current and default values", async () => {
    const node = element("Password");
    node.tagName = "INPUT";
    node.outerHTML = '<input id="save" type="password" value="initial-private">';
    const main = frame(node, [
      {
        localName: "input",
        type: "password",
        value: "edited-private",
        defaultValue: "initial-private",
      },
    ]);
    const html = (await inspectAtPoint(page(main), 15, 25))?.elements[0]?.element.htmlPreview;
    expect(html).toBe('<input id="save" type="password" value="••••••••">');
  });
  it("does not return context if masked values change while inspecting", async () => {
    const field = { localName: "input", type: "password", value: "before", defaultValue: "" };
    const main = frame(element("Form"), [field]);
    const evaluate = main.selected.evaluateNode.getMockImplementation()!;
    main.selected.evaluateNode.mockImplementation(async (...args) => {
      const result = await evaluate(...args);
      field.value = "after";
      return result;
    });
    await expect(inspectAtPoint(page(main), 15, 25)).rejects.toThrow("page changed");
    expect(main.selected.dispose).toHaveBeenCalledOnce();
  });
  it("masks before truncation so a password crossing the preview limit leaves no prefix", async () => {
    const secret = "boundary-private-value";
    const node = element("Form");
    node.outerHTML = `<div>${"x".repeat(11990)}${secret}</div>`;
    const main = frame(node, [
      { localName: "input", type: "password", value: secret, defaultValue: "" },
    ]);
    const html = (await inspectAtPoint(page(main), 15, 25))?.elements[0]?.element.htmlPreview;
    expect(html).not.toContain("boun");
    expect(html?.length).toBeLessThanOrEqual(12000);
  });
  it("returns no selection for an empty point and disposes its handle", async () => {
    const main = frame(null);
    expect(await inspectAtPoint(page(main), 0, 0)).toBeNull();
    expect(main.selected.dispose).toHaveBeenCalledOnce();
  });
});
