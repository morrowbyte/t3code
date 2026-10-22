import { EditorState, type Extension } from "@codemirror/state";

export interface ReviewSourceFile {
  readonly path: string;
  readonly content: string;
  readonly language?: string;
}

export interface ReviewSourceSymbol {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
}

/** Lines and columns are one-based; offsets in selection callbacks are zero-based. */
export interface ReviewSourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column?: number;
}

export interface ReviewSourceSelection {
  readonly path: string;
  readonly from: { readonly line: number; readonly column: number; readonly offset: number };
  readonly to: { readonly line: number; readonly column: number; readonly offset: number };
  readonly text: string;
}

export function createReviewSourceState(content: string, extensions: Extension = []) {
  return EditorState.create({
    doc: content,
    extensions: [
      EditorState.readOnly.of(true),
      // readOnly controls commands; this also rejects document-changing transactions.
      EditorState.transactionFilter.of((transaction) =>
        transaction.docChanged ? [] : transaction,
      ),
      extensions,
    ],
  });
}

export function sourceOffset(state: EditorState, location: ReviewSourceLocation) {
  const line = state.doc.line(
    Math.max(1, Math.min(state.doc.lines, Math.trunc(location.line) || 1)),
  );
  const column = Math.max(1, Math.trunc(location.column ?? 1) || 1);
  return Math.min(line.to, line.from + column - 1);
}

export function sourceLocation(
  state: EditorState,
  path: string,
  offset = state.selection.main.head,
) {
  const line = state.doc.lineAt(offset);
  return { path, line: line.number, column: offset - line.from + 1 };
}

export function sameSourceLocation(a: ReviewSourceLocation, b: ReviewSourceLocation) {
  return a.path === b.path && a.line === b.line && (a.column ?? 1) === (b.column ?? 1);
}

export interface ReviewSourceHistory {
  current: ReviewSourceLocation;
  back: ReviewSourceLocation[];
  forward: ReviewSourceLocation[];
}

export function visitSource(history: ReviewSourceHistory, location: ReviewSourceLocation) {
  if (sameSourceLocation(history.current, location)) return;
  history.back.push(history.current);
  if (history.back.length > 100) history.back.shift();
  history.current = location;
  history.forward = [];
}

export function traverseSource(history: ReviewSourceHistory, direction: "back" | "forward") {
  const destination = history[direction].pop();
  if (!destination) return undefined;
  history[direction === "back" ? "forward" : "back"].push(history.current);
  history.current = destination;
  return destination;
}

export function exactSourceDefinitions(
  name: string,
  symbols: readonly ReviewSourceSymbol[],
  files: readonly ReviewSourceFile[],
) {
  return symbols.filter((symbol, index) => {
    if (symbol.name !== name || !Number.isInteger(symbol.line) || symbol.line < 1) return false;
    const file = files.find((candidate) => candidate.path === symbol.path);
    if (!file || symbol.line > file.content.split("\n").length) return false;
    return !symbols
      .slice(0, index)
      .some(
        (other) =>
          other.name === symbol.name && other.path === symbol.path && other.line === symbol.line,
      );
  });
}

export interface SourceSearchHit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export function searchSourceBundle(files: readonly ReviewSourceFile[], query: string, limit = 200) {
  const hits: SourceSearchHit[] = [];
  if (!query) return { hits, limited: false };
  const needle = query.toLocaleLowerCase();
  for (const file of files) {
    const lines = file.content.split("\n");
    for (const [index, line] of lines.entries()) {
      const haystack = line.toLocaleLowerCase();
      let offset = haystack.indexOf(needle);
      while (offset !== -1) {
        if (hits.length === limit) return { hits, limited: true };
        hits.push({
          path: file.path,
          line: index + 1,
          column: offset + 1,
          preview: line.slice(Math.max(0, offset - 40), offset + query.length + 120),
        });
        offset = haystack.indexOf(needle, offset + Math.max(1, needle.length));
      }
    }
  }
  return { hits, limited: false };
}

export interface SourceTreeNode {
  name: string;
  path: string;
  filePath?: string;
  children: SourceTreeNode[];
}

export function sourceFileTree(files: readonly ReviewSourceFile[]) {
  const root: SourceTreeNode = { name: "", path: "", children: [] };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    let parent = root;
    const segments = file.path.split("/");
    for (const [index, name] of segments.entries()) {
      const path = segments.slice(0, index + 1).join("/");
      let node = parent.children.find((child) => child.path === path);
      if (!node) {
        node = { name: name || "/", path, children: [] };
        parent.children.push(node);
      }
      if (index === segments.length - 1) node.filePath = file.path;
      parent = node;
    }
  }
  return root.children;
}
