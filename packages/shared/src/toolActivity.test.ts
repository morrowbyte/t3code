import { describe, expect, it } from "vite-plus/test";

import {
  authoredCodeIntent,
  classifyToolActivity,
  dynamicToolSurface,
  dynamicToolTitle,
  mergeToolActivityData,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("classifies from kind and toolName without sniffing titles", () => {
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { toolName: "Grep" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    for (const toolName of ["github.read_file", "mongodb.find", "mcp__github__read_file"]) {
      expect(classifyToolActivity({ data: { toolName } })).toBe("other");
    }
    expect(classifyToolActivity({ title: "Find", data: {} })).toBe("other");
  });

  it("classifies Claude search tools ahead of their broad file-read request kind", () => {
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(classifyToolActivity({ requestKind: "file-read", data: { toolName } })).toBe("search");
    }
    expect(classifyToolActivity({ requestKind: "file-read", data: { toolName: "Read" } })).toBe(
      "read",
    );
  });

  it("keeps the first non-empty rawInput when a later update is empty", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { path: "src/a.ts", startLine: 4 } });
  });

  it("recognizes computer-use REPL calls before result metadata exists", () => {
    expect(dynamicToolSurface("cua_repl.js", {})).toBe("computer");
    for (const name of ["node_repl.js", "js"]) {
      expect(dynamicToolSurface(name, { code: "await sky.get_app_state(app);" })).toBe("computer");
      expect(dynamicToolSurface(name, { code: "const sky = await import('@oai/sky');" })).toBe(
        "computer",
      );
      expect(dynamicToolSurface(name, { code: "await fs.readFile(path);" })).toBeUndefined();
    }
    expect(dynamicToolSurface("github.js", { code: "await sky.click(app);" })).toBeUndefined();
  });
});

it("reads an explicit intent after Code Mode's pragma without mining source strings or opaque arguments", () => {
  const code =
    '// @exec: {"max_output_tokens": 1000}\n// Intent: Inspect current renderer metadata\nconst result = await tools.inspect({});\ntext(result.count);';
  expect(authoredCodeIntent(code)).toBe("Inspect current renderer metadata");
  expect(dynamicToolTitle("js", { code })).toBe("Inspect current renderer metadata");
  expect(
    dynamicToolTitle("runtime.added.tool", { title: "unrelated", description: "capability" }),
  ).toBeUndefined();
  expect(authoredCodeIntent('print("# Intent: fabricated")')).toBeUndefined();
  expect(dynamicToolTitle("runtime.added.tool", { code }, "Authored call title")).toBe(
    "Authored call title",
  );
});

it("shows a supplied intent immediately even when the provider sends a generic title", () => {
  const code = "// Intent: Inspect recording permission preferences\nawait inspect();";
  for (const toolName of ["js", "functions.exec", "node_repl.js"]) {
    expect(dynamicToolTitle(toolName, { code }, "Run shell commands")).toBe(
      "Inspect recording permission preferences",
    );
    expect(dynamicToolTitle(toolName, { code }, "Inspect host recording settings")).toBe(
      "Inspect host recording settings",
    );
  }
  expect(dynamicToolTitle("js", { code: "await inspect();" }, "Run JavaScript")).toBe(
    "Run JavaScript",
  );
});
