import {
  defaultKeymap,
  cursorLineDown,
  cursorLineUp,
  cursorPageDown,
  cursorPageUp,
} from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { closeSearchPanel, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, Prec } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CopyIcon,
  FilesIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useDeferredValue, useLayoutEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useStableCallback } from "~/hooks/useStableCallback";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  createReviewSourceState,
  exactSourceDefinitions,
  sameSourceLocation,
  searchSourceBundle,
  sourceFileTree,
  sourceLocation,
  sourceOffset,
  traverseSource,
  visitSource,
  type ReviewSourceFile,
  type ReviewSourceHistory,
  type ReviewSourceLocation,
  type ReviewSourceSelection,
  type ReviewSourceSymbol,
  type SourceTreeNode,
} from "./ReviewSourceEditor.logic";

export type {
  ReviewSourceFile,
  ReviewSourceLocation,
  ReviewSourceSelection,
  ReviewSourceSymbol,
} from "./ReviewSourceEditor.logic";

export interface ReviewSourceEditorProps {
  readonly files: readonly ReviewSourceFile[];
  readonly symbols: readonly ReviewSourceSymbol[];
  readonly location: ReviewSourceLocation;
  readonly onLocationChange: (location: ReviewSourceLocation) => void;
  readonly onSelectionChange?: (selection: ReviewSourceSelection) => void;
  readonly onClose?: () => void;
  /** A stable review/bundle ID preserves position across unmounting view switches. */
  readonly sessionKey?: string;
  readonly vimNavigation?: boolean;
  /** Hidden tabs defer editor layout and source reveals until activation. */
  readonly active?: boolean;
}

interface FilePosition {
  anchor: number;
  head: number;
  scroll: ReturnType<EditorView["scrollSnapshot"]>;
}

interface SourceSession extends ReviewSourceHistory {
  positions: Map<string, FilePosition>;
  query: string;
  vim: boolean;
}

// Only coordinates and scroll snapshots survive a view switch, never source text.
const sessions = new Map<string, SourceSession>();

const sourceTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.6",
  },
  ".cm-content": { padding: "8px 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    borderColor: "var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--accent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary) 25%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--muted)", color: "var(--foreground)" },
  ".cm-textfield, .cm-button": {
    background: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 30%, transparent)" },
  ".cm-searchMatch-selected": { outline: "1px solid var(--primary)" },
});

const sourceHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "var(--primary)" },
  { tag: [tags.string, tags.regexp], color: "var(--success-foreground)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning-foreground)" },
  { tag: [tags.comment, tags.meta], color: "var(--muted-foreground)", fontStyle: "italic" },
  {
    tag: [tags.function(tags.variableName), tags.typeName, tags.tagName],
    color: "var(--info-foreground)",
  },
  { tag: [tags.attributeName, tags.propertyName], color: "var(--foreground)" },
  { tag: tags.invalid, color: "var(--destructive)" },
]);

function FileTree({
  nodes,
  activePath,
  onOpen,
}: {
  nodes: readonly SourceTreeNode[];
  activePath: string;
  onOpen: (path: string) => void;
}) {
  return (
    <ul className="space-y-0.5 pl-2">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.filePath !== undefined && (
            <button
              type="button"
              className="min-h-11 w-full break-all rounded px-2 py-2.5 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-current:bg-accent sm:min-h-0 sm:py-1"
              aria-current={activePath === node.filePath ? "page" : undefined}
              onClick={() => onOpen(node.filePath!)}
            >
              {node.name}
            </button>
          )}
          {node.children.length > 0 && (
            <details open>
              <summary className="min-h-11 cursor-pointer rounded px-1 py-2.5 text-xs focus-visible:outline-2 focus-visible:outline-ring sm:min-h-0 sm:py-1">
                {node.name}
              </summary>
              <FileTree nodes={node.children} activePath={activePath} onOpen={onOpen} />
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ReviewSourceEditor(props: ReviewSourceEditorProps) {
  return <ReviewSourceEditorView key={props.sessionKey} {...props} />;
}

function ReviewSourceEditorView(props: ReviewSourceEditorProps) {
  const savedSession = props.sessionKey ? sessions.get(props.sessionKey) : undefined;
  const sessionRef = useRef<SourceSession>(
    savedSession ?? {
      current: props.location,
      back: [],
      forward: [],
      positions: new Map(),
      query: "",
      vim: props.vimNavigation ?? false,
    },
  );
  const [activePath, setActivePath] = useState(savedSession?.current.path ?? props.location.path);
  const [cursor, setCursor] = useState(savedSession?.current ?? props.location);
  const [history, setHistory] = useState({
    back: savedSession?.back.length ?? 0,
    forward: savedSession?.forward.length ?? 0,
  });
  const [query, setQuery] = useState(savedSession?.query ?? "");
  const [vim, setVim] = useState(savedSession?.vim ?? props.vimNavigation ?? false);
  const isNarrow = useMediaQuery("max-sm");
  const [filesOpen, setFilesOpen] = useState<boolean | null>(null);
  const showFiles = filesOpen ?? !isNarrow;
  const [notice, setNotice] = useState("");
  const [definitions, setDefinitions] = useState<readonly ReviewSourceSymbol[]>([]);
  const [syntax, setSyntax] = useState("Plain text");
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const pendingJump = useRef<ReviewSourceLocation | null>(null);
  const pendingFocus = useRef(false);
  const previousExternal = useRef<ReviewSourceLocation | null>(null);
  const latest = useRef(props);
  const traverseRef = useRef<(direction: "back" | "forward") => void>(() => {});
  const definitionRef = useRef<() => void>(() => {});
  const tree = sourceFileTree(props.files);
  const deferredQuery = useDeferredValue(query);
  const results = searchSourceBundle(props.files, deferredQuery);
  const activeFile = props.files.find((file) => file.path === activePath);
  const filePath = activeFile?.path;
  const fileContent = activeFile?.content;
  const fileLanguage = activeFile?.language;
  const active = props.active ?? true;

  useLayoutEffect(() => {
    latest.current = props;
    sessionRef.current.query = query;
    sessionRef.current.vim = vim;
  });

  useLayoutEffect(() => {
    if (!props.sessionKey) return;
    sessions.delete(props.sessionKey);
    sessions.set(props.sessionKey, sessionRef.current);
    if (sessions.size > 12) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
  }, [props.sessionKey]);

  const navigate = useStableCallback((location: ReviewSourceLocation, restore = false) => {
    const file = latest.current.files.find((candidate) => candidate.path === location.path);
    if (!file) {
      setNotice(`Source unavailable: ${location.path}`);
      return;
    }
    if (isNarrow) setFilesOpen(false);
    const view = editor.current;
    if (restore && sessionRef.current.positions.has(file.path)) {
      const saved = sessionRef.current.positions.get(file.path)!;
      const state = createReviewSourceState(file.content);
      location = sourceLocation(state, file.path, Math.min(saved.head, state.doc.length));
    }
    visitSource(sessionRef.current, location);
    setHistory({
      back: sessionRef.current.back.length,
      forward: sessionRef.current.forward.length,
    });
    setNotice("");
    setDefinitions([]);
    if (view && view.contentDOM.dataset.sourcePath === location.path) {
      const offset = sourceOffset(view.state, location);
      view.dispatch({
        selection: EditorSelection.cursor(offset),
        effects: EditorView.scrollIntoView(offset, { y: "center" }),
      });
      view.focus();
    } else {
      pendingJump.current = restore ? null : location;
      pendingFocus.current = true;
      setActivePath(location.path);
      latest.current.onLocationChange(location);
    }
  });

  const traverse = useStableCallback((direction: "back" | "forward") => {
    const destination = traverseSource(sessionRef.current, direction);
    if (destination) navigate(destination);
  });

  const showDefinition = useStableCallback(() => {
    const view = editor.current;
    if (!view) return;
    const selected = view.state.selection.main;
    const word = selected.empty ? view.state.wordAt(selected.head) : selected;
    const name = word ? view.state.sliceDoc(word.from, word.to).trim() : "";
    const matches = exactSourceDefinitions(name, latest.current.symbols, latest.current.files);
    setDefinitions(matches.length > 1 ? matches : []);
    if (matches.length === 1) {
      navigate(matches[0]!);
    } else {
      setNotice(
        matches.length > 1
          ? `Choose a definition for “${name}”.`
          : name
            ? `No indexed definition for “${name}”.`
            : "Select a symbol or place the cursor on its name.",
      );
    }
  });

  useLayoutEffect(() => {
    traverseRef.current = traverse;
    definitionRef.current = showDefinition;
  }, [traverse, showDefinition]);

  useLayoutEffect(() => {
    if (!active || !host.current || filePath === undefined || fileContent === undefined) return;
    const path = filePath;
    const language = new Compartment();
    let disposed = false;
    const saved = sessionRef.current.positions.get(filePath);
    const jump = pendingJump.current;
    pendingJump.current = null;
    const state = createReviewSourceState(fileContent, [
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({
        tabindex: "0",
        role: "textbox",
        "aria-readonly": "true",
        "aria-multiline": "true",
        "aria-label": `Source: ${filePath}`,
        "data-source-path": filePath,
      }),
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      highlightActiveLine(),
      search({ top: true }),
      sourceTheme,
      syntaxHighlighting(sourceHighlight),
      language.of([]),
      Prec.highest(
        keymap.of([
          {
            key: "Ctrl-o",
            run: () => {
              traverseRef.current("back");
              return true;
            },
          },
          {
            key: "Ctrl-i",
            run: () => {
              traverseRef.current("forward");
              return true;
            },
          },
          {
            key: "F12",
            run: () => {
              definitionRef.current();
              return true;
            },
          },
          ...(vim
            ? [
                { key: "j", run: cursorLineDown },
                { key: "k", run: cursorLineUp },
                { key: "Ctrl-u", run: (view: EditorView) => cursorPageUp(view) },
                { key: "Ctrl-d", run: (view: EditorView) => cursorPageDown(view) },
              ]
            : []),
        ]),
      ),
      keymap.of([...searchKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet) reportSelection(update.view);
      }),
      EditorView.domEventHandlers({
        scroll: (_event, view) => {
          remember(view);
          return false;
        },
      }),
    ]);
    const initialOffset = jump
      ? sourceOffset(state, jump)
      : saved
        ? Math.min(saved.head, state.doc.length)
        : sourceOffset(state, sessionRef.current.current);
    const initialState = state.update({
      selection: EditorSelection.single(
        saved && !jump ? Math.min(saved.anchor, state.doc.length) : initialOffset,
        initialOffset,
      ),
    }).state;
    const view = new EditorView({
      parent: host.current,
      state: initialState,
      scrollTo:
        saved && !jump ? saved.scroll : EditorView.scrollIntoView(initialOffset, { y: "center" }),
    });
    editor.current = view;
    if (pendingFocus.current) {
      pendingFocus.current = false;
      view.focus();
    }
    reportSelection(view);

    function remember(current: EditorView) {
      // A tab can already be display:none during cleanup; its zero-sized scroll
      // geometry must not replace the last snapshot recorded while visible.
      if (current.scrollDOM.clientHeight === 0 || current.scrollDOM.clientWidth === 0) return;
      const selection = current.state.selection.main;
      sessionRef.current.positions.set(path, {
        anchor: selection.anchor,
        head: selection.head,
        scroll: current.scrollSnapshot(),
      });
    }

    function reportSelection(current: EditorView) {
      const location = sourceLocation(current.state, path);
      sessionRef.current.current = location;
      setCursor(location);
      remember(current);
      latest.current.onLocationChange(location);
      const { from, to } = current.state.selection.main;
      const fromLocation = sourceLocation(current.state, path, from);
      const toLocation = sourceLocation(current.state, path, to);
      latest.current.onSelectionChange?.({
        path,
        from: { line: fromLocation.line, column: fromLocation.column, offset: from },
        to: { line: toLocation.line, column: toLocation.column, offset: to },
        text: current.state.sliceDoc(from, to),
      });
    }

    const description =
      (fileLanguage
        ? LanguageDescription.matchLanguageName(languages, fileLanguage, true)
        : null) ?? LanguageDescription.matchFilename(languages, filePath);
    setSyntax(description ? `Loading ${description.name}…` : "Plain text");
    if (description) {
      void description
        .load()
        .then((support) => {
          if (disposed) return;
          view.dispatch({ effects: language.reconfigure(support) });
          setSyntax(description.name);
        })
        .catch(() => {
          if (!disposed) setSyntax(`${description.name} highlighting unavailable`);
        });
    }
    return () => {
      disposed = true;
      remember(view);
      view.destroy();
      if (editor.current === view) editor.current = null;
    };
  }, [active, filePath, fileContent, fileLanguage, vim]);

  useLayoutEffect(() => {
    if (previousExternal.current && sameSourceLocation(previousExternal.current, props.location))
      return;
    previousExternal.current = props.location;
    if (!sameSourceLocation(sessionRef.current.current, props.location)) navigate(props.location);
  }, [props.location, navigate]);

  async function copySelection() {
    const view = editor.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (from === to) {
      setNotice("Select source text to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(view.state.sliceDoc(from, to));
      setNotice("Selection copied.");
    } catch {
      setNotice("Clipboard unavailable. Use your browser’s Copy command on the selection.");
    }
  }

  return (
    <section
      className="flex h-full min-h-64 min-w-0 flex-col bg-background text-foreground"
      aria-label="Review source editor"
      data-keyboard-local="true"
      onKeyDownCapture={(event) => {
        const view = editor.current;
        if (event.key === "Escape" && view && view.dom.querySelector(".cm-search")) {
          // Consume the local search dismissal before the enclosing dialog sees Escape.
          event.preventDefault();
          event.stopPropagation();
          closeSearchPanel(view);
          view.focus();
        }
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.altKey || event.metaKey) return;
        if (event.ctrlKey && !event.shiftKey && (event.key === "o" || event.key === "i")) {
          event.preventDefault();
          event.stopPropagation();
          traverse(event.key === "o" ? "back" : "forward");
        } else if (event.key === "F12" && !event.ctrlKey && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          showDefinition();
        }
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-2">
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:min-w-40 sm:flex-1">
          <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-xs">
            {activePath}
          </span>
          <span className="shrink-0 px-1 text-xs text-muted-foreground">Read only</span>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto">
          <Button
            variant="ghost"
            size="icon-xl"
            aria-label="Toggle source files"
            aria-expanded={showFiles}
            onClick={() => setFilesOpen(!showFiles)}
          >
            <FilesIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xl"
            aria-label="Back (Ctrl+O)"
            disabled={history.back === 0}
            onClick={() => traverse("back")}
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xl"
            aria-label="Forward (Ctrl+I)"
            disabled={history.forward === 0}
            onClick={() => traverse("forward")}
          >
            <ArrowRightIcon />
          </Button>
          <Button variant="ghost" size="lg" disabled={!activeFile} onClick={showDefinition}>
            Definition
          </Button>
          <Button
            variant="ghost"
            size="icon-xl"
            aria-label="Copy selection"
            disabled={!activeFile}
            onClick={() => {
              void copySelection();
            }}
          >
            <CopyIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xl"
            aria-label="Find in file"
            disabled={!activeFile}
            onClick={() => {
              if (editor.current) {
                openSearchPanel(editor.current);
              }
            }}
          >
            <SearchIcon />
          </Button>
          <Button
            variant={vim ? "secondary" : "ghost"}
            size="lg"
            aria-pressed={vim}
            aria-label="Vim keys: j/k move lines, Ctrl+U/D move pages"
            onClick={() => setVim(!vim)}
          >
            Vim keys
          </Button>
          {props.onClose && (
            <Button
              variant="ghost"
              size="icon-xl"
              aria-label="Close source editor"
              onClick={props.onClose}
            >
              <XIcon />
            </Button>
          )}
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col sm:flex-row">
        {showFiles && (
          <aside
            className="absolute inset-y-0 left-0 z-20 flex w-full flex-col overflow-auto border-b border-border bg-background sm:static sm:w-56 sm:shrink-0 sm:border-r sm:border-b-0"
            aria-label="Source bundle"
          >
            <div className="sticky top-0 z-10 bg-background p-2">
              <Input
                type="search"
                size="compact"
                aria-label="Search source bundle"
                placeholder="Search all files"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {deferredQuery ? (
              <div aria-label="Source search results" aria-busy={query !== deferredQuery}>
                <p className="px-3 py-1 text-xs text-muted-foreground" role="status">
                  {results.hits.length}
                  {results.limited ? "+" : ""} matches{results.limited ? " · refine search" : ""}
                </p>
                <ul>
                  {results.hits.map((hit) => (
                    <li key={`${hit.path}:${hit.line}:${hit.column}`}>
                      <button
                        type="button"
                        className="w-full break-all px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => navigate(hit)}
                      >
                        <span className="block font-medium">
                          {hit.path}:{hit.line}
                        </span>
                        <span className="block font-mono text-muted-foreground">{hit.preview}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <nav aria-label="Source files" className="p-1">
                <FileTree
                  nodes={tree}
                  activePath={activePath}
                  onOpen={(path) => navigate({ path, line: 1 }, true)}
                />
              </nav>
            )}
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {notice && (
            <p role="status" className="border-b border-border px-3 py-2 text-xs">
              {notice}
            </p>
          )}
          {definitions.length > 1 && (
            <ul
              aria-label="Indexed definitions"
              className="max-h-40 overflow-auto border-b border-border"
            >
              {definitions.map((symbol) => (
                <li key={`${symbol.path}:${symbol.line}`}>
                  <button
                    type="button"
                    className="w-full break-all px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => navigate(symbol)}
                  >
                    {symbol.name} — {symbol.path}:{symbol.line}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
          {!activeFile && (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {props.files.length
                ? `Source unavailable: ${activePath}`
                : "No source files in this review."}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-t border-border px-3 py-1 text-xs text-muted-foreground">
        <span>
          Ln {cursor.line}, Col {cursor.column ?? 1}
        </span>
        <span>{syntax}</span>
        <span>{props.files.length} files</span>
      </div>
    </section>
  );
}
