import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronDownIcon, FileTextIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { MessageCopyButton } from "./MessageCopyButton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findRevealRef } from "./markdownFindContext";

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

function messageParts(text: string) {
  // Only plain, unbroken prose gets display-only paragraph breaks. Code and
  // authored Markdown keep their own structure; the original is never changed.
  if (/[\r\n]|[`#*]|\[[^\]]*\]\(/.test(text)) {
    return { lead: text.split(/\r?\n/, 1)[0] ?? text, body: text };
  }
  const sentences: string[] = [];
  let pending = "";
  let germanQuoteOpen = false;
  for (const part of sentenceSegmenter.segment(text)) {
    pending += part.segment;
    for (const character of part.segment) {
      if (character === "„") germanQuoteOpen = true;
      else if (character === "“") germanQuoteOpen = false;
    }
    if (!germanQuoteOpen) {
      sentences.push(pending);
      pending = "";
    }
  }
  if (pending) sentences.push(pending);
  return {
    lead: sentences[0] ?? text,
    body: sentences.slice(1).join("\n\n"),
  };
}

export function AgentMessageRow({
  messageId,
  text,
  senderThreadId,
  senderTitle,
  attribution,
  environmentId,
  createdAt,
  timestamp,
  timestampTitle,
  streaming,
  delivery,
  children,
}: {
  messageId: string;
  text: string;
  senderThreadId: ThreadId | undefined;
  senderTitle: string | null;
  attribution: "agent" | "unknown";
  environmentId: EnvironmentId;
  createdAt: string;
  timestamp: string;
  timestampTitle: string;
  streaming: boolean;
  delivery?: ReactNode;
  children: (bodyText: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const originalPanelId = useId();
  const parts = messageParts(text);
  const messageLabel = attribution === "agent" ? "agent message" : "MCP message";
  const collapse = () => {
    setExpanded(false);
    setOriginalOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  return (
    <article
      className="min-w-0 border-b border-border/70 py-4"
      data-agent-message={messageId}
      data-user-message-attribution={attribution}
    >
      <div className="mb-2 flex min-w-0 items-start gap-3 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0">{attribution === "agent" ? "Agent" : "MCP"}</span>
          {senderThreadId ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: senderThreadId }}
              className="inline-flex min-w-0 items-center gap-1 rounded-sm font-medium text-foreground/80 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={`Open sending thread: ${senderTitle ?? senderThreadId}`}
            >
              <span className="truncate">{senderTitle ?? "Sending thread"}</span>
              <ArrowUpRightIcon className="size-3 shrink-0" aria-hidden />
            </Link>
          ) : (
            <span>Sender not recorded</span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger render={<time className="shrink-0 tabular-nums" dateTime={createdAt} />}>
            {timestamp}
          </TooltipTrigger>
          <TooltipPopup>{timestampTitle}</TooltipPopup>
        </Tooltip>
      </div>
      <Collapsible
        open={expanded}
        onOpenChange={(open) => {
          setExpanded(open);
          if (!open) setOriginalOpen(false);
        }}
      >
        <CollapsibleTrigger
          ref={trigger}
          className="flex w-full items-start justify-between gap-4 rounded-sm py-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${messageLabel}`}
        >
          <span
            className={`min-w-0 text-base leading-snug font-medium tracking-tight text-foreground [overflow-wrap:anywhere] ${expanded ? "" : "line-clamp-2"}`}
          >
            {parts.lead || (attribution === "agent" ? "Agent message" : "MCP message")}
          </span>
          <ChevronDownIcon
            className={
              expanded
                ? "mt-1 size-4 shrink-0 rotate-180 text-muted-foreground"
                : "mt-1 size-4 shrink-0 text-muted-foreground"
            }
            aria-hidden
          />
        </CollapsibleTrigger>
        <div
          ref={findRevealRef(() => setExpanded(true))}
          data-thread-find-fold={!expanded ? "" : undefined}
        >
          <CollapsiblePanel animate={false} keepMounted>
            <div
              className="pt-3 text-sm leading-relaxed [overflow-wrap:anywhere]"
              data-thread-find-text="true"
            >
              {children(parts.body)}
            </div>
          </CollapsiblePanel>
        </div>
      </Collapsible>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={originalOpen}
          aria-controls={originalPanelId}
          onClick={() => setOriginalOpen(!originalOpen)}
        >
          <FileTextIcon /> Original
        </Button>
        <MessageCopyButton text={text} label="Copy original" variant="ghost" />
        {expanded ? (
          <Button size="xs" variant="ghost-muted" onClick={collapse}>
            Show less
          </Button>
        ) : null}
        {streaming ? (
          <span className="ml-auto text-xs text-muted-foreground" role="status">
            Receiving…
          </span>
        ) : null}
        {delivery}
      </div>
      <Collapsible open={originalOpen}>
        <CollapsiblePanel id={originalPanelId} animate={false}>
          <pre
            tabIndex={0}
            data-agent-message-original="true"
            className="mt-3 max-h-[50dvh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
          >
            {text}
          </pre>
        </CollapsiblePanel>
      </Collapsible>
    </article>
  );
}
