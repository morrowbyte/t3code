import { useState } from "react";
import type { EnvironmentId, LiveVoiceCallSummary, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, PhoneIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useEnvironmentQuery } from "~/state/query";
import {
  earlierVoiceCallHistoryQuery,
  voiceCallHistoryQuery,
  voiceCallTranscriptQuery,
} from "~/rpc/liveVoiceHistory";
import { LiveVoiceTranscriptContent } from "./LiveVoiceTranscript";
import { useVoiceCallHistoryFollow } from "./useVoiceCallHistoryFollow";

function callStatus(status: LiveVoiceCallSummary["status"]) {
  switch (status) {
    case "closed":
      return "Ended";
    case "failed":
      return "Failed";
    case "active":
      return "Live";
    case "preparing":
    case "prepared":
    case "starting":
      return "Connecting";
    case "stopping":
      return "Ending";
    case "unknown":
      return "Interrupted";
  }
}

function callDuration(call: LiveVoiceCallSummary) {
  if (!call.activeAt || !call.endedAt) return null;
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(call.endedAt) - Date.parse(call.activeAt)) / 1_000),
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function CallTranscript({
  environmentId,
  call,
}: {
  environmentId: EnvironmentId;
  call: LiveVoiceCallSummary;
}) {
  const query = useEnvironmentQuery(
    voiceCallTranscriptQuery({
      environmentId,
      input: {
        threadId: call.threadId,
        leaseId: call.leaseId,
        generation: call.generation,
        lastEventId: call.lastEventId,
      },
    }),
  );
  if (query.error)
    return <HistoryError onRetry={query.refresh} text="Couldn’t load this transcript." />;
  if (!query.data)
    return (
      <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
        Loading transcript…
      </p>
    );
  return (
    <div className="border-t border-border/60 px-3 py-3 sm:px-4">
      {query.data.incomplete && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          Some transcript segments are incomplete.
        </p>
      )}
      {query.data.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transcript was received.</p>
      ) : (
        <LiveVoiceTranscriptContent transcript={query.data.entries} />
      )}
    </div>
  );
}

function HistoryError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>{text}</span>
      <Button size="xs" variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function VoiceCall({
  environmentId,
  call,
}: {
  environmentId: EnvironmentId;
  call: LiveVoiceCallSummary;
}) {
  const [open, setOpen] = useState(false);
  const duration = callDuration(call);
  const time = new Date(call.startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <li className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        aria-label={`Voice call, ${time}, ${callStatus(call.status)}${duration ? `, ${duration}` : ""}`}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left text-xs outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <PhoneIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">Voice call</span>
        <time dateTime={call.startedAt} className="text-muted-foreground">
          {time}
        </time>
        <span className="ml-auto flex gap-2 text-muted-foreground">
          {duration && (
            <span className="tabular-nums" aria-label="Call duration">
              {duration}
            </span>
          )}
          <span>{callStatus(call.status)}</span>
        </span>
      </button>
      {open && <CallTranscript environmentId={environmentId} call={call} />}
    </li>
  );
}

function HistoryPage({
  environmentId,
  threadId,
  before,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  before?: string;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const query = useEnvironmentQuery(
    (before ? earlierVoiceCallHistoryQuery : voiceCallHistoryQuery)({
      environmentId,
      input: { threadId, ...(before ? { before } : {}) },
    }),
  );
  if (query.error)
    return <HistoryError text="Voice call history is unavailable." onRetry={query.refresh} />;
  if (!query.data)
    return before ? (
      <p role="status" className="text-xs text-muted-foreground">
        Loading earlier calls…
      </p>
    ) : null;
  const history = query.data;
  return (
    <>
      {!history.persistenceAvailable && (
        <p role="alert" className="py-2 text-xs text-destructive">
          Voice call history could not be saved completely.
        </p>
      )}
      {history.nextBefore &&
        (showEarlier ? (
          <HistoryPage
            environmentId={environmentId}
            threadId={threadId}
            before={history.nextBefore}
          />
        ) : (
          <div className="mb-2">
            <Button variant="ghost" size="xs" onClick={() => setShowEarlier(true)}>
              Earlier voice calls
            </Button>
          </div>
        ))}
      {history.calls.length > 0 && (
        <ol aria-label="Voice calls" className="space-y-2 py-2">
          {history.calls.toReversed().map((call) => (
            <VoiceCall
              key={`${call.leaseId}:${call.generation}`}
              environmentId={environmentId}
              call={call}
            />
          ))}
        </ol>
      )}
    </>
  );
}

export function WebVoiceCallHistory({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const historyRef = useVoiceCallHistoryFollow();
  return (
    <section ref={historyRef} aria-label="Voice call history" className="chat-content-lane">
      <HistoryPage
        key={`${environmentId}:${threadId}`}
        environmentId={environmentId}
        threadId={threadId}
      />
    </section>
  );
}
