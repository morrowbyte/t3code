import { useState } from "react";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  ATTENTION_CATEGORIES,
  attentionCoverageLabel,
  type AttentionCategory,
  type AttentionFilter,
  type AttentionInboxModel,
} from "./attentionInbox";

export function AttentionInboxView({
  model,
  environmentLabel,
  status,
  hasSnapshot,
  synchronizationError,
  navigationError,
  onOpenThread,
}: {
  model: AttentionInboxModel;
  environmentLabel: string;
  status: EnvironmentShellStatus;
  hasSnapshot: boolean;
  synchronizationError: string | null;
  navigationError: string | null;
  onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const [filter, setFilter] = useState<AttentionFilter>("all");
  const [shown, setShown] = useState(50);
  const categories = Object.keys(ATTENTION_CATEGORIES) as AttentionCategory[];
  const visible = model.entries.filter((entry) => filter === "all" || entry.category === filter);
  const chooseFilter = (next: AttentionFilter) => {
    setFilter(next);
    setShown(50);
  };
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-xs text-muted-foreground">
        <p role="status">{attentionCoverageLabel(status, hasSnapshot)}</p>
        <p>
          Selected environment: {environmentLabel}. {model.loadedThreads} loaded unarchived threads.
          Latest pending request and latest unsettled completion per thread. Other environments are
          not included.
        </p>
        {model.completionTimeUnavailable > 0 ? (
          <p>
            Completion time is unavailable for {model.completionTimeUnavailable} loaded threads;
            their completion is not inferred.
          </p>
        ) : null}
      </div>
      {synchronizationError ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {synchronizationError}
        </p>
      ) : null}
      {navigationError ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {navigationError}
        </p>
      ) : null}
      <div role="group" aria-label="Attention categories" className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={filter === "all" ? "secondary" : "outline"}
          aria-pressed={filter === "all"}
          onClick={() => chooseFilter("all")}
        >
          All ({model.entries.length})
        </Button>
        {categories.map((category) => (
          <Button
            key={category}
            size="sm"
            variant={filter === category ? "secondary" : "outline"}
            aria-pressed={filter === category}
            onClick={() => chooseFilter(category)}
          >
            {ATTENTION_CATEGORIES[category]} ({model.counts[category]})
          </Button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          {!hasSnapshot
            ? "Attention items are unavailable until environment data loads."
            : status !== "live"
              ? "No matching items in the cached data. Current attention is not verified."
              : "No matching attention items in the loaded threads."}
        </p>
      ) : (
        <ul aria-label="Attention items" className="space-y-3">
          {visible.slice(0, shown).map((entry) => (
            <li key={entry.id} className="space-y-2 rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" size="sm">
                  {ATTENTION_CATEGORIES[entry.category]}
                </Badge>
                <span className="text-sm font-medium">{entry.title}</span>
              </div>
              <p className="wrap-anywhere text-sm font-medium">{entry.threadTitle}</p>
              <p className="wrap-anywhere whitespace-pre-wrap text-sm text-muted-foreground">
                {entry.description}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <time dateTime={entry.occurredAt} className="text-xs text-muted-foreground">
                  {new Date(entry.occurredAt).toLocaleString()}
                </time>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Open source conversation: ${entry.threadTitle}`}
                  onClick={() => onOpenThread(entry.threadRef)}
                >
                  Open thread
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {visible.length > shown ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Showing {shown} of {visible.length} matching items.
          </p>
          <Button size="sm" variant="outline" onClick={() => setShown((count) => count + 50)}>
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
