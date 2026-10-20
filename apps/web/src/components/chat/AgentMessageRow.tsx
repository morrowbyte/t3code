import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArrowDownLeftIcon, ArrowUpRightIcon, ChevronDownIcon, FileTextIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MessageCopyButton } from "./MessageCopyButton";
import { findRevealRef } from "./markdownFindContext";
import { parseAgentMessage } from "./agentMessagePresentation";
import { AgentIdentityLabel } from "../agent-identity/AgentIdentityLabel";
import { handleObjectActionKey } from "./objectKeyboardActions";

const STATUS = {
  info: { label: "Info", variant: "secondary" },
  fertig: { label: "Fertig", variant: "success" },
  blockiert: { label: "Blockiert", variant: "warning" },
  frage: { label: "Frage", variant: "info" },
  entscheidung: { label: "Entscheidung", variant: "warning" },
} as const;

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

function legacyParagraphs(text: string) {
  if (/[\r\n`#*]|\[[^\]]*\]\(/u.test(text)) return [{ key: "message", text }];
  // Sentence boundaries only change presentation; copy and audit use text.
  return Array.from(sentences.segment(text), ({ segment, index }) => ({
    key: String(index),
    text: segment,
  }));
}

function keyedSections<T extends { readonly label: string }>(sections: ReadonlyArray<T>) {
  const counts = new Map<string, number>();
  return sections.map((section) => {
    const occurrence = counts.get(section.label) ?? 0;
    counts.set(section.label, occurrence + 1);
    return { ...section, key: `${section.label}:${occurrence}` };
  });
}

function originalExcerpt(text: string) {
  const firstLine = text.trimStart().split(/\r?\n/u, 1)[0] ?? "";
  if (firstLine.length <= 150) return firstLine;
  const boundary = firstLine.lastIndexOf(" ", 150);
  return `${firstLine.slice(0, boundary > 90 ? boundary : 150)}…`;
}

export function AgentMessageRow({
  messageId,
  text,
  peerThreadId,
  peerTitle,
  attribution,
  direction = "incoming",
  environmentId,
  createdAt,
  timestamp,
  timestampTitle,
  streaming,
  delivery,
  attachments,
  loading = false,
  error,
  onRequestText,
  children,
}: {
  messageId: string;
  text: string | null;
  peerThreadId: ThreadId | undefined;
  peerTitle: string | null;
  attribution: "agent" | "unknown";
  direction?: "incoming" | "outgoing";
  environmentId: EnvironmentId;
  createdAt: string;
  timestamp: string;
  timestampTitle: string;
  streaming: boolean;
  delivery?: ReactNode;
  attachments?: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRequestText?: () => void;
  children: (bodyText: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const originalPanelId = useId();
  const parsed = text === null ? null : parseAgentMessage(text);
  const status = parsed?.status && parsed.status !== "info" ? STATUS[parsed.status] : null;
  const keyed = keyedSections(parsed?.sections ?? []);
  const sections = keyed.filter((section) => section.kind !== "technical");
  const technical = keyed.filter((section) => section.kind === "technical");
  const outgoing = direction === "outgoing";
  const DirectionIcon = outgoing ? ArrowUpRightIcon : ArrowDownLeftIcon;
  const summary = parsed?.summary ?? (text ? originalExcerpt(text) : "Agentennachricht");
  const collapse = () => {
    setExpanded(false);
    setOriginalOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  return (
    <article
      data-keyboard-object="Message"
      tabIndex={-1}
      aria-label={`Agent message: ${summary}`}
      data-keyboard-help="C: copy this message · D: toggle details · J/K: messages · H/L: actions"
      onKeyDown={(event) => handleObjectActionKey(event, { c: "copy", d: "details" })}
      className={`min-w-0 rounded-lg border px-3.5 py-3 sm:px-4 ${outgoing ? "border-dashed border-border bg-background" : "border-border/70 bg-muted/20"}`}
      data-agent-message={messageId}
      data-agent-message-direction={direction}
      data-agent-message-format={parsed?.kind ?? "loading"}
      data-user-message-attribution={attribution}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <DirectionIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">{outgoing ? "An" : "Von"}</span>
        {peerThreadId ? (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: peerThreadId }}
            className="min-w-0 truncate rounded-sm font-medium text-foreground/85 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`${outgoing ? "Zielthread" : "Absenderthread"} öffnen: ${peerTitle ?? peerThreadId}`}
          >
            <AgentIdentityLabel
              threadRef={{ environmentId, threadId: peerThreadId }}
              featureTitle={peerTitle}
            />
          </Link>
        ) : (
          <span className="min-w-0 truncate">
            {outgoing
              ? "Agent · Ziel nicht erfasst"
              : attribution === "unknown"
                ? "MCP · Absender nicht erfasst"
                : "Agent · Absender nicht erfasst"}
          </span>
        )}
        <span className="ml-auto shrink-0">
          <Tooltip>
            <TooltipTrigger render={<time className="tabular-nums" dateTime={createdAt} />}>
              {timestamp}
            </TooltipTrigger>
            <TooltipPopup>{timestampTitle}</TooltipPopup>
          </Tooltip>
        </span>
        {text && !streaming ? <MessageCopyButton text={text} variant="ghost" /> : null}
      </div>
      <Collapsible
        open={expanded}
        onOpenChange={(open) => {
          setExpanded(open);
          if (open) onRequestText?.();
          else setOriginalOpen(false);
        }}
      >
        <CollapsibleTrigger
          ref={trigger}
          className="flex w-full items-start gap-2.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
          aria-label={`${expanded ? "Zuklappen" : "Details öffnen"}: Agentennachricht`}
          data-keyboard-action="details"
          aria-keyshortcuts="D"
        >
          <span className="min-w-0 flex-1">
            {parsed?.kind === "legacy" ? (
              <span className="mb-1 block text-2xs text-muted-foreground">Auszug</span>
            ) : null}
            <span
              className={`text-sm leading-relaxed font-medium text-foreground [overflow-wrap:anywhere] ${expanded ? "block" : "line-clamp-2"}`}
            >
              {summary}
            </span>
          </span>
          <ChevronDownIcon
            className={`mt-1 size-3.5 shrink-0 text-muted-foreground ${expanded ? "rotate-180" : ""}`}
            aria-hidden
          />
        </CollapsibleTrigger>
        {status || delivery || streaming ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
            {status ? (
              <Badge size="sm" variant={status.variant}>
                {status.label}
              </Badge>
            ) : null}
            {delivery}
            {streaming ? <span role="status">Wird übertragen…</span> : null}
          </div>
        ) : null}
        <div
          ref={findRevealRef(() => setExpanded(true))}
          data-thread-find-fold={!expanded ? "" : undefined}
        >
          <CollapsiblePanel animate={false} keepMounted>
            <div
              className="mt-3 border-t border-border/60 pt-3 text-sm [overflow-wrap:anywhere]"
              data-thread-find-text="true"
            >
              {attachments}
              {loading ? (
                <p role="status" className="text-muted-foreground">
                  Original wird geladen…
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              ) : null}
              {parsed?.kind === "structured" ? (
                <div className="space-y-4">
                  {sections.map((section) => (
                    <section
                      key={section.key}
                      className={
                        section.kind === "open" || section.kind === "decision"
                          ? "border-l-2 border-warning/50 pl-3"
                          : ""
                      }
                    >
                      <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                        {section.label}
                      </h4>
                      {children(section.text)}
                    </section>
                  ))}
                  {technical.length > 0 ? (
                    <details className="text-sm">
                      <summary className="w-fit cursor-pointer rounded-sm text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
                        Technik
                      </summary>
                      <div className="mt-2 space-y-3">
                        {technical.map((section) => (
                          <div key={section.key}>{children(section.text)}</div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              ) : text !== null ? (
                <div className="space-y-3">
                  {legacyParagraphs(text).map((paragraph) => (
                    <div key={paragraph.key}>{children(paragraph.text)}</div>
                  ))}
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border/60 pt-2">
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-expanded={originalOpen}
                  aria-controls={originalPanelId}
                  onClick={() => {
                    setOriginalOpen(!originalOpen);
                    onRequestText?.();
                  }}
                >
                  <FileTextIcon /> Original
                </Button>
                {text !== null ? (
                  <MessageCopyButton text={text} label="Original kopieren" variant="ghost" />
                ) : null}
                <span className="ml-auto">
                  <Button size="xs" variant="ghost-muted" onClick={collapse}>
                    Zuklappen
                  </Button>
                </span>
              </div>
              <Collapsible open={originalOpen}>
                <CollapsiblePanel id={originalPanelId} animate={false}>
                  <pre
                    tabIndex={0}
                    data-agent-message-original="true"
                    className="mt-2 max-h-[50dvh] overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
                  >
                    {text}
                  </pre>
                </CollapsiblePanel>
              </Collapsible>
            </div>
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </article>
  );
}
