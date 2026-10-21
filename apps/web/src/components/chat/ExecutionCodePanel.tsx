import type { EnvironmentId, OrchestrationV2TurnItem, ScopedThreadRef } from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import * as DateTime from "effect/DateTime";
import { Suspense, useRef, useState } from "react";
import {
  executionCode,
  matchesExecutionTarget,
  type ExecutionCodeTarget,
} from "../../lib/executionCode";
import { embeddedScripts } from "../../lib/embeddedScripts";
import { useTurnItemDetail } from "../../state/queries";
import { useTheme } from "../../hooks/useTheme";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { HighlightedTokens } from "./HighlightedTokens";

export interface ExecutionCodePanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly target: ExecutionCodeTarget;
  readonly environmentLabel?: string | undefined;
  readonly wireItem?: OrchestrationV2TurnItem | undefined;
}

function ExecutionSyntax(props: {
  code: string;
  language: string;
  shell: boolean;
  theme: "light" | "dark";
}) {
  const embedded =
    props.shell && props.language === "shellscript" ? embeddedScripts(props.code) : [];
  return (
    <HighlightedTokens
      code={props.code}
      language={props.language}
      embedded={embedded}
      theme={props.theme}
    />
  );
}

/** Uses the same authorized on-demand item read as the timeline inspector. */
export function ExecutionCodePanel(props: ExecutionCodePanelProps) {
  const bound = props.threadRef.environmentId === props.target.environmentId;
  const validWire =
    bound && props.wireItem && matchesExecutionTarget(props.wireItem, props.target)
      ? props.wireItem
      : undefined;
  const detail = useTurnItemDetail(
    bound
      ? {
          environmentId: props.threadRef.environmentId,
          threadId: props.target.threadId,
          itemId: props.target.itemId,
          revision: validWire ? turnItemDetailRevision(validWire) : "restored",
        }
      : null,
  );
  const fetched = detail.data?.item;
  const fresh =
    bound &&
    fetched &&
    matchesExecutionTarget(fetched, props.target) &&
    (!validWire ||
      DateTime.toEpochMillis(fetched.updatedAt) >= DateTime.toEpochMillis(validWire.updatedAt))
      ? fetched
      : undefined;
  // The command projection retains full input; detail reads cap large strings.
  const item =
    fresh?.type === "command_execution" && validWire?.type === "command_execution"
      ? { ...fresh, input: validWire.input }
      : (fresh ?? validWire);
  return (
    <ExecutionCodeView
      key={`${props.target.environmentId}:${props.target.threadId}:${props.target.runId}:${props.target.itemId}`}
      environmentId={props.target.environmentId}
      environmentLabel={bound ? props.environmentLabel : undefined}
      target={props.target}
      item={item}
      pending={detail.isPending}
      error={detail.error !== null}
    />
  );
}

export function ExecutionCodeView(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string | undefined;
  readonly target: ExecutionCodeTarget;
  readonly item?: OrchestrationV2TurnItem | undefined;
  readonly pending: boolean;
  readonly error: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const item =
    props.item && matchesExecutionTarget(props.item, props.target) ? props.item : undefined;
  const code = item ? executionCode(item) : null;
  const [query, setQuery] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const searchInput = useRef<HTMLInputElement>(null);
  const source = useRef<HTMLPreElement>(null);
  const [matchIndex, setMatchIndex] = useState(-1);
  const copyInput = async () => {
    if (!code?.text) return;
    try {
      await navigator.clipboard.writeText(code.text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const nextMatch = (direction: -1 | 1) => {
    if (!query || !code?.text || !source.current) return;
    const text = code.text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const offsets: number[] = [];
    for (
      let offset = text.indexOf(needle);
      offset >= 0;
      offset = text.indexOf(needle, offset + Math.max(1, needle.length))
    )
      offsets.push(offset);
    if (!offsets.length) return;
    const next =
      matchIndex < 0
        ? direction > 0
          ? 0
          : offsets.length - 1
        : (matchIndex + direction + offsets.length) % offsets.length;
    setMatchIndex(next);
    const start = offsets[next]!;
    const end = start + query.length;
    const walker = document.createTreeWalker(source.current, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let position = 0;
    let hasStart = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.textContent?.length ?? 0;
      if (!hasStart && position + length >= start) {
        range.setStart(node, start - position);
        hasStart = true;
      }
      if (hasStart && position + length >= end) {
        range.setEnd(node, end - position);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        node.parentElement?.scrollIntoView?.({ block: "center", inline: "nearest" });
        break;
      }
      position += length;
    }
  };
  const matches = (() => {
    if (!query || !code?.text) return [];
    return code.text
      .split(/\r?\n/u)
      .flatMap((line, index) =>
        line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [index + 1] : [],
      );
  })();
  const time = (value: OrchestrationV2TurnItem["startedAt"] | undefined) =>
    value ? DateTime.formatIso(value) : "Not supplied";
  return (
    <section
      aria-label="Execution code"
      className="flex min-h-0 flex-1 flex-col overflow-auto p-3"
      data-keyboard-object="Execution code"
      data-keyboard-local="true"
      data-keyboard-help="/: find · Enter / Shift Enter in search: next / previous match · Y: copy recorded input · Esc: leave search"
      onKeyDownCapture={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          (event.target instanceof Element &&
            event.target.closest('input,textarea,[contenteditable="true"]'))
        )
          return;
        if (event.key === "/") {
          event.preventDefault();
          event.stopPropagation();
          searchInput.current?.focus();
        }
        if (event.key.toLowerCase() === "y") {
          event.preventDefault();
          event.stopPropagation();
          void copyInput();
        }
      }}
    >
      <h2 className="text-sm font-medium">{code?.title ?? "Recorded input unavailable"}</h2>
      <dl className="my-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs wrap-break-word">
        <dt>Environment / host</dt>
        <dd>{props.environmentLabel ?? props.environmentId}</dd>
        <dt>Environment ID</dt>
        <dd>{props.environmentId}</dd>
        <dt>Thread</dt>
        <dd>{props.target.threadId}</dd>
        <dt>Run</dt>
        <dd>{props.target.runId ?? "Not supplied"}</dd>
        <dt>Item</dt>
        <dd>{props.target.itemId}</dd>
        <dt>Observed status</dt>
        <dd>{item?.status ?? "Unavailable"}</dd>
        <dt>Working directory</dt>
        <dd>{code?.cwd ?? "Not supplied for this execution"}</dd>
        <dt>Started</dt>
        <dd>{time(item?.startedAt)}</dd>
        <dt>Completed</dt>
        <dd>{time(item?.completedAt)}</dd>
        <dt>Exit code</dt>
        <dd>{code?.exitCode ?? "Not supplied"}</dd>
      </dl>
      <p className="mb-3 text-xs text-muted-foreground">
        Recorded provider input. A script filename does not include its historical file contents.
        Opening this view does not run code.
      </p>
      {code?.inputField ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Original input field: {code.inputField}
        </p>
      ) : null}
      {code?.text !== null && code?.text !== undefined ? (
        <>
          {code.text.length > 65_536 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Large input shown as complete plain text.
            </p>
          ) : null}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="min-w-0 flex-1 text-xs">
              Find in recorded input
              <input
                ref={searchInput}
                aria-label="Find in recorded input"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setMatchIndex(-1);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    nextMatch(event.shiftKey ? -1 : 1);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                    setMatchIndex(-1);
                    source.current?.focus();
                  }
                }}
                className="mt-1 block w-full rounded-sm border border-input bg-background px-2 py-1"
              />
            </label>
            <Button size="sm" variant="outline" onClick={() => void copyInput()}>
              Copy input
            </Button>
          </div>
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            {query
              ? matches.length
                ? `Matches on lines ${matches.join(", ")}`
                : "No matches"
              : ""}
            {copyState === "copied"
              ? " Input copied."
              : copyState === "failed"
                ? " Could not copy input."
                : ""}
            {query && matchIndex >= 0 ? ` Match ${matchIndex + 1}.` : ""}
          </p>
          <pre
            ref={source}
            aria-label="Recorded input"
            tabIndex={0}
            className="min-h-40 shrink-0 overflow-auto border border-border p-3 font-mono text-xs whitespace-pre select-text"
          >
            <RenderErrorBoundary fallback={code.text} resetKeys={[code.text]}>
              <Suspense fallback={code.text}>
                {code.text.length > 65_536 ? (
                  code.text
                ) : (
                  <ExecutionSyntax
                    code={code.text}
                    language={code.language}
                    shell={code.shell}
                    theme={resolvedTheme}
                  />
                )}
              </Suspense>
            </RenderErrorBoundary>
          </pre>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {props.pending
            ? "Loading recorded input…"
            : (code?.unavailable ?? "Recorded input is unavailable for this item.")}
          {props.error ? " The authorized item read failed." : ""}
        </p>
      )}
      {code?.argumentsText ? (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer">Complete structured input</summary>
          <pre
            aria-label="Complete structured input"
            tabIndex={0}
            className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap select-text"
          >
            {code.argumentsText}
          </pre>
        </details>
      ) : null}
      <details className="mt-4 text-xs">
        <summary className="cursor-pointer">Output / errors (separate from input)</summary>
        <pre
          aria-label="Recorded output"
          tabIndex={0}
          className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap select-text"
        >
          {code?.output ??
            (props.pending
              ? "Loading output…"
              : code?.outputOmitted
                ? "Complete output is unavailable from the item read."
                : "No output supplied.")}
        </pre>
      </details>
    </section>
  );
}
