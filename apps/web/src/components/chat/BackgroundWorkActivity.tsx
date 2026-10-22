import type { PendingBackgroundWorkPresentation } from "@t3tools/client-runtime/state/thread-execution";
import { withVisibleControlCharacters } from "@t3tools/client-runtime/work-log/command-label";
import type { ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button, InlineButton } from "../ui/button";

const COMMAND_STATUS_LABELS = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
} as const;

export function BackgroundWorkActivity({
  presentation,
  canStop,
  stopping,
  onStopThread,
  onOpenThread,
}: {
  readonly presentation: PendingBackgroundWorkPresentation;
  readonly canStop: boolean;
  readonly stopping: boolean;
  readonly onStopThread: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const detailsId = useId();
  const stopButton = (
    <Button
      size="xs"
      variant="ghost"
      disabled={!canStop || stopping}
      aria-label="Stop all work in this thread"
      className="ms-auto"
      onClick={onStopThread}
    >
      <SquareIcon />
      {stopping ? "Stopping thread…" : "Stop thread"}
    </Button>
  );
  const single = presentation.items.length === 1;
  return (
    <section aria-label="Background activity" className="min-w-0 px-2 py-1">
      {single ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
          <span className="text-xs text-muted-foreground">
            {presentation.items.length} activities
          </span>
          {stopButton}
        </div>
      )}
      <div className="max-h-[min(36dvh,20rem)] overflow-y-auto overscroll-contain">
        {presentation.items.map((item, index) => {
          const open = expanded.has(item.taskId);
          const panelId = `${detailsId}-${index}`;
          const childThreadId = item.childThreadId;
          const statusLabel = stopping
            ? "Stopping…"
            : item.kind === "monitor"
              ? "Watching"
              : item.commandStatus === undefined
                ? "Active"
                : COMMAND_STATUS_LABELS[item.commandStatus];
          return (
            <div key={item.taskId} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <button
                  type="button"
                  aria-label={`${open ? "Hide" : "Show"} details for ${item.commandLabel ?? item.label}`}
                  aria-describedby={`${panelId}-status`}
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() =>
                    setExpanded((previous) => {
                      const next = new Set(previous);
                      if (open) next.delete(item.taskId);
                      else next.add(item.taskId);
                      return next;
                    })
                  }
                  className="flex min-h-9 min-w-0 flex-1 basis-40 cursor-pointer items-center gap-2 rounded-md px-1 text-start text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <TerminalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {item.commandLabel ?? item.label}
                    </span>
                    <span id={`${panelId}-status`} className="block text-xs text-muted-foreground">
                      {statusLabel}
                    </span>
                  </span>
                  <ChevronRightIcon
                    aria-hidden
                    className={`size-3.5 shrink-0 text-muted-foreground ${open ? "rotate-90" : ""}`}
                  />
                </button>
                {single ? stopButton : null}
              </div>
              {open ? (
                <div id={panelId} className="space-y-2 px-1 pb-3 pt-2">
                  {item.commandLine === undefined ? (
                    <p className="whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                      {item.label}
                    </p>
                  ) : (
                    <pre
                      aria-label="Full command"
                      tabIndex={0}
                      className="max-h-44 overflow-y-auto rounded-lg border border-border/60 bg-background/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/85 wrap-anywhere outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      {withVisibleControlCharacters(item.commandLine)}
                    </pre>
                  )}
                  {childThreadId === undefined ? null : (
                    <InlineButton onClick={() => onOpenThread(childThreadId)}>
                      Open subagent
                    </InlineButton>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
