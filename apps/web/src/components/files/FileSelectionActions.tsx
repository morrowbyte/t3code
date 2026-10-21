import { useRef, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useComposerHandleContext } from "~/composerHandleContext";
import { buildFileReviewComment, formatReviewCommentFence } from "~/reviewCommentContext";
import { Button } from "../ui/button";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { nextFileCommentId } from "./fileCommentAnnotations";

export function FileSelectionActions(props: {
  readonly filePath: string;
  readonly contents: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}) {
  const composer = useComposerHandleContext();
  const addReviewComment = useComposerDraftStore((state) => state.addReviewComment);
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(1);
  const [commenting, setCommenting] = useState(false);
  const [added, setAdded] = useState(false);
  const summary = useRef<HTMLElement>(null);
  const lineCount = props.contents.split("\n").length;
  const comment = (id: string, text: string) =>
    buildFileReviewComment({
      id,
      filePath: props.filePath,
      contents: props.contents,
      startLine: Math.max(1, Math.min(lineCount, start)),
      endLine: Math.max(1, Math.min(lineCount, end)),
      text,
    });
  const selected = comment("selection-preview", "");
  return (
    <details
      className="shrink-0 border-b px-3 py-1 text-xs"
      data-keyboard-object="Source selection"
      tabIndex={-1}
      data-keyboard-help="Enter: select lines · Tab: range and actions · Ctrl Enter: add comment · Esc: cancel comment"
    >
      <summary ref={summary} data-keyboard-primary className="cursor-pointer">
        Select lines
      </summary>
      <div className="flex flex-wrap items-center gap-2 py-2">
        <label>
          From{" "}
          <input
            type="number"
            min={1}
            max={lineCount}
            aria-label="Selection start line"
            value={start}
            className="w-20 rounded-sm border bg-background px-2 py-1"
            onChange={(event) => {
              setStart(Math.max(1, event.currentTarget.valueAsNumber || 1));
              setAdded(false);
            }}
          />
        </label>
        <label>
          To{" "}
          <input
            type="number"
            min={1}
            max={lineCount}
            aria-label="Selection end line"
            value={end}
            className="w-20 rounded-sm border bg-background px-2 py-1"
            onChange={(event) => {
              setEnd(Math.max(1, event.currentTarget.valueAsNumber || 1));
              setAdded(false);
            }}
          />
        </label>
        <Button size="xs" variant="ghost" onClick={() => setCommenting(true)}>
          Comment selection
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!composer}
          onClick={() => {
            composer?.current?.insertTextAtEnd(
              `\n${selected.filePath}:${selected.rangeLabel}\n${formatReviewCommentFence(selected.fenceLanguage ?? "", selected.diff)}\n`,
            );
          }}
        >
          Quote selection
        </Button>
        {added ? <span role="status">Comment added to draft</span> : null}
      </div>
      <pre
        aria-label="Selected source lines"
        className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono"
      >
        {selected.diff}
      </pre>
      {commenting ? (
        <DiffCommentAnnotation
          kind="draft"
          rangeLabel={selected.rangeLabel}
          text=""
          onCancel={() => {
            setCommenting(false);
            summary.current?.focus();
          }}
          onComment={(text) => {
            addReviewComment(props.composerDraftTarget, comment(nextFileCommentId(), text));
            setCommenting(false);
            setAdded(true);
            summary.current?.focus();
          }}
        />
      ) : null}
    </details>
  );
}
