import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { useComposerHandleContext } from "~/composerHandleContext";
import { Button } from "../ui/button";
import { moveDiffSelection } from "./diffKeyboardSelection";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { fnv1a32, resolveFileDiffPath } from "~/lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
  formatReviewCommentFence,
} from "~/reviewCommentContext";

import { nextFileCommentId } from "../files/fileCommentAnnotations";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from "./StyledDiffCodeView";

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup, undefined>;
const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

function annotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = annotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  codeViewKey: string;
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    fileVersion: number;
    collapsed: boolean;
  }>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderCodeViewFooter?: () => ReactNode;
  unsafeCSSExtra?: string;
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderFilenameSuffix: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
  onRevealSearchMatch: (fileKey: string) => void;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  codeViewKey,
  files,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  viewerRef,
  className,
  renderCodeViewFooter,
  unsafeCSSExtra,
  renderHeaderMetadata,
  renderHeaderFilenameSuffix,
  renderHeaderPrefix,
  onRevealSearchMatch,
}: AnnotatableCodeViewProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const composer = useComposerHandleContext();
  const [codeView, setCodeView] = useState<AnnotatableCodeViewHandle | null>(null);
  const region = useRef<HTMLDivElement>(null);
  useImperativeHandle(viewerRef, () => codeView!, [codeView]);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<{
    fileKey: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);
  const [draftText, setDraftText] = useState("");

  const filesByKey = new Map(files.map((file) => [file.fileKey, file]));
  const items: CodeViewDiffItem<DiffCommentAnnotationGroup>[] = files.map(
    ({ fileDiff, filePath, fileKey, fileVersion, collapsed }) => {
      const persisted = reviewComments
        .filter(
          (comment) =>
            comment.sectionId === sectionId &&
            comment.filePath === filePath &&
            (comment.fenceLanguage ?? "diff") === "diff",
        )
        .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
          const range = restoreDiffReviewCommentRange(fileDiff, comment);
          if (!range) return annotations;
          return appendAnnotationEntry(annotations, range, {
            id: comment.id,
            kind: "comment",
            range,
            rangeLabel: comment.rangeLabel,
            text: comment.text,
          });
        }, []);
      const annotations = draft?.fileKey === fileKey ? [...persisted, draft.annotation] : persisted;
      return {
        id: fileKey,
        type: "diff",
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(
          `${fileVersion}:${collapsed ? "1" : "0"}:${annotations
            .flatMap((annotation) =>
              annotation.metadata.entries.map(
                (entry) => `${entry.id}:${entry.rangeLabel}:${entry.text}`,
              ),
            )
            .join(":")}`,
        ),
      };
    },
  );

  const removeEntry = (entryId: string) => {
    setSelectedLines(null);
    if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
      setDraft(null);
      setDraftText("");
    } else {
      removeReviewComment(composerDraftTarget, entryId);
    }
  };

  const submitEntry = (entryId: string, text: string) => {
    const entry = draft?.annotation.metadata.entries.find((candidate) => candidate.id === entryId);
    const file = draft ? filesByKey.get(draft.fileKey) : undefined;
    if (!entry || !file) return;
    const comment = buildDiffReviewComment({
      id: entry.id,
      sectionId,
      sectionTitle,
      filePath: file.filePath,
      fileDiff: file.fileDiff,
      range: entry.range,
      text,
    });
    if (comment) addReviewComment(composerDraftTarget, comment);
    setSelectedLines(null);
    setDraft(null);
    setDraftText("");
  };

  const beginComment = (range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range) return;
    const item = context.item;
    if (item.type !== "diff") return;
    // Read from the item, not the file list, so the compiled callback keeps its identity
    // as patches arrive; the viewer re-applies its options whenever it changes.
    const id = nextFileCommentId();
    const comment = buildDiffReviewComment({
      id,
      sectionId,
      sectionTitle,
      filePath: resolveFileDiffPath(item.fileDiff),
      fileDiff: item.fileDiff,
      range,
      text: "",
    });
    if (!comment) return;
    setDraftText("");
    setDraft({
      fileKey: item.id,
      annotation: {
        side: annotationSide(range),
        lineNumber: range.end,
        metadata: {
          entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
        },
      },
    });
  };

  const hasOpenComment = draft !== null;
  const keyboardFile = files.find((file) => file.fileKey === selectedLines?.id) ?? files[0];
  const keyboardRange =
    selectedLines?.range ??
    (keyboardFile?.fileDiff.hunks[0]
      ? {
          start: keyboardFile.fileDiff.hunks[0].additionCount
            ? keyboardFile.fileDiff.hunks[0].additionStart
            : keyboardFile.fileDiff.hunks[0].deletionStart,
          end: keyboardFile.fileDiff.hunks[0].additionCount
            ? keyboardFile.fileDiff.hunks[0].additionStart
            : keyboardFile.fileDiff.hunks[0].deletionStart,
          side: keyboardFile.fileDiff.hunks[0].additionCount
            ? ("additions" as const)
            : ("deletions" as const),
        }
      : null);
  const selectKeyboardRange = (file: (typeof files)[number], range: SelectedLineRange) => {
    onRevealSearchMatch(file.fileKey);
    setSelectedLines({ id: file.fileKey, range });
    codeView?.scrollTo({ type: "range", id: file.fileKey, range, align: "nearest" });
  };
  const commentSelection = () => {
    if (!keyboardFile || !keyboardRange || hasOpenComment) return;
    selectKeyboardRange(keyboardFile, keyboardRange);
    const item = items.find((entry) => entry.id === keyboardFile.fileKey);
    if (item) beginComment(keyboardRange, { item });
  };
  const quoteSelection = () => {
    if (!keyboardFile || !keyboardRange) return;
    const quote = buildDiffReviewComment({
      id: nextFileCommentId(),
      sectionId,
      sectionTitle,
      filePath: keyboardFile.filePath,
      fileDiff: keyboardFile.fileDiff,
      range: keyboardRange,
      text: "",
    });
    if (quote)
      composer?.current?.insertTextAtEnd(
        `\n${quote.filePath}:${quote.rangeLabel}\n${formatReviewCommentFence("diff", quote.diff)}\n`,
      );
  };
  return (
    <div
      ref={region}
      role="region"
      tabIndex={0}
      aria-label={`${sectionTitle} code`}
      data-keyboard-local="true"
      data-keyboard-object="Diff code"
      data-keyboard-help="J/K: lines · Shift J/K: select range · H/L: old/new side · [ / ]: hunks · { / }: files · C: comment · Y: quote in chat"
      className="flex h-full min-h-0 flex-1 flex-col outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      onKeyDownCapture={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          hasOpenComment
        )
          return;
        if (
          event.nativeEvent
            .composedPath()
            .some(
              (node) =>
                node instanceof Element && node.matches('input,textarea,[contenteditable="true"]'),
            )
        )
          return;
        if (!keyboardFile || !keyboardRange) return;
        const key = event.key.toLowerCase();
        if (key === "c") commentSelection();
        else if (key === "y") quoteSelection();
        else {
          const next = moveDiffSelection(
            files,
            { id: keyboardFile.fileKey, range: keyboardRange },
            key,
            event.shiftKey,
          );
          const file = files.find((file) => file.fileKey === next?.id);
          if (!next || !file) return;
          selectKeyboardRange(file, next.range);
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-xs">
        <span role="status" className="min-w-0 flex-1 truncate">
          {keyboardFile?.filePath}
          {keyboardRange ? `:${keyboardRange.start}–${keyboardRange.end}` : ""}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={!keyboardRange || hasOpenComment}
          onClick={commentSelection}
        >
          Comment selection
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!keyboardRange || !composer}
          onClick={quoteSelection}
        >
          Quote selection
        </Button>
      </div>
      <StyledDiffCodeView<DiffCommentAnnotationGroup>
        key={codeViewKey}
        viewerRef={setCodeView}
        className={`min-h-0 flex-1 ${className ?? ""}`}
        {...(unsafeCSSExtra ? { unsafeCSSExtra } : {})}
        {...(renderHeaderMetadata
          ? {
              renderHeaderMetadata: (item: CodeViewItem<DiffCommentAnnotationGroup>) =>
                item.type === "diff" ? renderHeaderMetadata(item.fileDiff) : null,
            }
          : {})}
        {...(renderCodeViewFooter ? { renderCodeViewFooter } : {})}
        items={items}
        selectedLines={selectedLines}
        onSelectedLinesChange={setSelectedLines}
        onRevealSearchMatch={(item) => onRevealSearchMatch(item.id)}
        options={{
          ...options,
          enableGutterUtility: !hasOpenComment,
          enableLineSelection: !hasOpenComment,
          onGutterUtilityClick: beginComment,
        }}
        renderHeaderFilenameSuffix={(item) =>
          item.type === "diff" ? renderHeaderFilenameSuffix(item.fileDiff) : null
        }
        renderHeaderPrefix={(item) =>
          item.type === "diff"
            ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
            : null
        }
        renderAnnotation={(annotation) => {
          const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
          return (
            <div
              className={hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
            >
              {annotation.metadata.entries.map((entry) => (
                <DiffCommentAnnotation
                  key={entry.id}
                  kind={entry.kind}
                  rangeLabel={entry.rangeLabel}
                  text={entry.kind === "draft" ? draftText : entry.text}
                  onTextChange={setDraftText}
                  onCancel={() => {
                    removeEntry(entry.id);
                    region.current?.focus({ preventScroll: true });
                  }}
                  onComment={(text) => {
                    submitEntry(entry.id, text);
                    region.current?.focus({ preventScroll: true });
                  }}
                  onDelete={() => removeEntry(entry.id)}
                />
              ))}
            </div>
          );
        }}
      />
    </div>
  );
}
