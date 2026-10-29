import { useAtomSubscribe } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import type { EnvironmentId, LiveVoiceCallSummary, ThreadId } from "@t3tools/contracts";
import {
  retainVoiceCalls,
  voiceCallKey,
  voiceConversationItems,
  type VoiceConversationItem,
  type VoiceTranscriptSnapshot,
} from "@t3tools/client-runtime/live-voice";
import { voiceSpeechBubbles } from "@t3tools/client-runtime/live-voice/bubbles";
import { VoiceBubbleViewToggle, useVoiceBubbleView } from "./VoiceBubbleViewToggle";
import { Button } from "~/components/ui/button";
import { useEnvironmentQuery } from "~/state/query";
import {
  earlierVoiceCallHistoryQuery,
  voiceCallHistoryQuery,
  voiceCallTranscriptQuery,
} from "~/rpc/liveVoiceHistory";
import { useObservedVoiceConversation } from "./VoiceConversation";
import { VoiceConversationRow } from "./VoiceConversationRow";

type Snapshot = VoiceTranscriptSnapshot | "error";
type HistoryProps = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

function TranscriptLoader({
  environmentId,
  call,
  register,
}: {
  readonly environmentId: EnvironmentId;
  readonly call: LiveVoiceCallSummary;
  readonly register: (key: string, snapshot: Snapshot) => void;
}) {
  const query = voiceCallTranscriptQuery({
    environmentId,
    input: {
      threadId: call.threadId,
      leaseId: call.leaseId,
      generation: call.generation,
      lastEventId: call.lastEventId,
    },
  });
  useAtomSubscribe(
    query,
    (result) => {
      const snapshot = AsyncResult.isFailure(result)
        ? "error"
        : AsyncResult.getOrElse(result, () => null);
      if (snapshot)
        register(
          voiceCallKey(call),
          snapshot === "error"
            ? "error"
            : { transcript: snapshot, throughEventId: call.lastEventId },
        );
    },
    { immediate: true },
  );
  return null;
}

type EarlierCallsProps = HistoryProps & {
  readonly before: string;
  readonly register: (calls: ReadonlyArray<LiveVoiceCallSummary>) => void;
};

function EarlierCalls(props: EarlierCallsProps) {
  const [expanded, setExpanded] = useState(false);
  return expanded ? (
    <EarlierCallsPage {...props} />
  ) : (
    <Button variant="ghost" size="xs" onClick={() => setExpanded(true)}>
      Earlier voice calls
    </Button>
  );
}

function EarlierCallsPage({ environmentId, threadId, before, register }: EarlierCallsProps) {
  const atom = earlierVoiceCallHistoryQuery({ environmentId, input: { threadId, before } });
  useAtomSubscribe(
    atom,
    (result) => {
      const calls = AsyncResult.isFailure(result)
        ? null
        : AsyncResult.getOrElse(result, () => null)?.calls;
      if (calls) register(calls);
    },
    { immediate: true },
  );
  const query = useEnvironmentQuery(atom);
  if (query.error)
    return <HistoryError text="Earlier voice calls are unavailable." onRetry={query.refresh} />;
  if (!query.data)
    return (
      <p role="status" className="py-2 text-xs text-muted-foreground">
        Loading earlier calls…
      </p>
    );
  return query.data.nextBefore ? (
    <EarlierCalls
      environmentId={environmentId}
      threadId={threadId}
      before={query.data.nextBefore}
      register={register}
    />
  ) : null;
}

function HistoryError({ text, onRetry }: { readonly text: string; readonly onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground"
    >
      <span>{text}</span>
      <Button size="xs" variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function WebVoiceCallHistory({
  environmentId,
  threadId,
  children,
}: HistoryProps & {
  readonly children?: (
    items: ReadonlyArray<VoiceConversationItem>,
    controls: ReactNode,
  ) => ReactNode;
}) {
  const query = useEnvironmentQuery(voiceCallHistoryQuery({ environmentId, input: { threadId } }));
  const [retained, setRetained] = useState<ReadonlyArray<LiveVoiceCallSummary>>([]);
  const [transcripts, setTranscripts] = useState<ReadonlyMap<string, Snapshot>>(new Map());
  const observed = useObservedVoiceConversation(environmentId, threadId);
  const [bubbles] = useVoiceBubbleView();
  const incoming = query.error ? null : query.data?.calls;
  const registerCalls = (calls: ReadonlyArray<LiveVoiceCallSummary>) =>
    setRetained((previous) => retainVoiceCalls(previous, calls));
  const registerTranscript = (key: string, snapshot: Snapshot) =>
    setTranscripts((previous) =>
      previous.get(key) === snapshot ? previous : new Map(previous).set(key, snapshot),
    );
  const calls = query.error ? [] : retainVoiceCalls(retained, incoming ?? []);
  if (!query.error && calls !== retained) setRetained(calls);
  const received = voiceConversationItems(calls, transcripts, observed);
  const items = bubbles ? voiceSpeechBubbles(received, { environmentId, threadId }) : received;
  const controls = (
    <div className="chat-content-lane">
      {items.length > 0 && <VoiceBubbleViewToggle />}
      {query.error ? (
        <HistoryError text="Voice call history is unavailable." onRetry={query.refresh} />
      ) : (
        <>
          {query.data?.persistenceAvailable === false && (
            <p role="alert" className="py-2 text-xs text-destructive">
              Voice call history could not be saved completely.
            </p>
          )}
          {query.data?.nextBefore && (
            <EarlierCalls
              key={query.data.nextBefore}
              environmentId={environmentId}
              threadId={threadId}
              before={query.data.nextBefore}
              register={registerCalls}
            />
          )}
        </>
      )}
    </div>
  );
  return (
    <>
      {calls.map((call) => (
        <TranscriptLoader
          key={voiceCallKey(call)}
          environmentId={environmentId}
          call={call}
          register={registerTranscript}
        />
      ))}
      {children ? (
        children(items, controls)
      ) : (
        <section aria-label="Voice conversation">
          {controls}
          {items.map((item) => (
            <VoiceConversationRow key={item.id} item={item} />
          ))}
        </section>
      )}
    </>
  );
}
