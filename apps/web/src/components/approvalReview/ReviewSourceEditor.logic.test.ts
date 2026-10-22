import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";

import {
  createReviewSourceState,
  exactSourceDefinitions,
  searchSourceBundle,
  sourceFileTree,
  sourceLocation,
  sourceOffset,
  traverseSource,
  visitSource,
  type ReviewSourceHistory,
} from "./ReviewSourceEditor.logic";

describe("immutable review source", () => {
  it("rejects insert, delete and replace transactions while allowing text selection", () => {
    const content = "export const answer = 42;\nanswer;";
    const original = createReviewSourceState(content);
    for (const changes of [
      { from: 0, insert: "malicious" },
      { from: 0, to: original.doc.length },
      { from: 13, to: 19, insert: "changed" },
    ]) {
      expect(original.update({ changes }).state.doc.toString()).toBe(content);
    }
    const selected = original.update({ selection: EditorSelection.range(13, 19) }).state;
    expect(selected.sliceDoc(selected.selection.main.from, selected.selection.main.to)).toBe(
      "answer",
    );
    expect(selected.readOnly).toBe(true);
  });

  it("clamps external locations and reports one-based cursor coordinates", () => {
    const state = createReviewSourceState("first\nsecond\n");
    expect(sourceOffset(state, { path: "a.ts", line: 2, column: 3 })).toBe(8);
    expect(sourceLocation(state, "a.ts", 8)).toEqual({ path: "a.ts", line: 2, column: 3 });
    expect(sourceOffset(state, { path: "a.ts", line: -1, column: 999 })).toBe(5);
    expect(sourceOffset(state, { path: "a.ts", line: 999 })).toBe(state.doc.length);
  });
});

describe("source index and bundle", () => {
  it("returns only exact provided definitions, preserves ambiguity and rejects absent source", () => {
    const files = [
      { path: "a.ts", content: "function target() {}\ntarget()" },
      { path: "b.ts", content: "// target" },
    ];
    const symbols = [
      { name: "target", path: "a.ts", line: 1 },
      { name: "target", path: "a.ts", line: 1 },
      { name: "target", path: "b.ts", line: 1 },
      { name: "target", path: "missing.ts", line: 1 },
      { name: "target", path: "a.ts", line: 100 },
      { name: "targetElse", path: "a.ts", line: 2 },
    ];
    expect(exactSourceDefinitions("target", symbols, files)).toEqual([symbols[0], symbols[2]]);
    expect(exactSourceDefinitions("Target", symbols, files)).toEqual([]);
    expect(exactSourceDefinitions("function", symbols, files)).toEqual([]);
  });

  it("searches beyond visible snippets across all source files and reports capped results", () => {
    const files = [
      { path: "a.ts", content: `${"blank\n".repeat(2000)}needle needle` },
      { path: "nested/b.ts", content: "Needle" },
    ];
    expect(
      searchSourceBundle(files, "needle").hits.map(({ path, line, column }) => ({
        path,
        line,
        column,
      })),
    ).toEqual([
      { path: "a.ts", line: 2001, column: 1 },
      { path: "a.ts", line: 2001, column: 8 },
      { path: "nested/b.ts", line: 1, column: 1 },
    ]);
    expect(searchSourceBundle(files, "needle", 2)).toMatchObject({
      limited: true,
      hits: [{ path: "a.ts" }, { path: "a.ts" }],
    });
    expect(searchSourceBundle(files, "")).toEqual({ hits: [], limited: false });
    expect(sourceFileTree(files)[1]).toMatchObject({
      name: "nested",
      children: [{ filePath: "nested/b.ts" }],
    });
  });
});

describe("cross-file jump history", () => {
  it("retains exact return columns, supports forward, and discards forward after a new jump", () => {
    const first = { path: "a.ts", line: 3, column: 9 };
    const second = { path: "b.ts", line: 11, column: 2 };
    const history: ReviewSourceHistory = { current: first, back: [], forward: [] };
    visitSource(history, second);
    history.current = { ...second, line: 12, column: 6 };
    expect(traverseSource(history, "back")).toEqual(first);
    expect(traverseSource(history, "forward")).toEqual({ ...second, line: 12, column: 6 });
    traverseSource(history, "back");
    visitSource(history, { path: "c.ts", line: 1 });
    expect(traverseSource(history, "forward")).toBeUndefined();
    expect(traverseSource(history, "back")).toEqual(first);
  });
});
