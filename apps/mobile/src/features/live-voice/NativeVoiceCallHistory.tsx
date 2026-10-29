import { useAtomSubscribe } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import type { EnvironmentId, LiveVoiceCallSummary, ThreadId } from "@t3tools/contracts";
import {
  retainVoiceCalls,
  voiceCallKey,
  voiceConversationItems,
  type VoiceConversationItem,
  type VoiceTranscriptSnapshot,
} from "@t3tools/client-runtime/live-voice";
import { voiceSpeechBubbles } from "@t3tools/client-runtime/live-voice/bubbles";
import {
  NativeVoiceBubbleViewToggle,
  useNativeVoiceBubbleView,
} from "./NativeVoiceBubbleViewToggle";
import { Button } from "../../components/ui/Button";
import { AppText } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import {
  earlierVoiceCallHistoryQuery,
  voiceCallHistoryQuery,
  voiceCallTranscriptQuery,
} from "./voiceCallHistory";
import { useNativeVoiceObserved } from "./NativeVoiceConversation";

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
  const receiveSnapshot = useCallback(
    (result: Atom.Type<typeof query>) => {
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
    [call, register],
  );
  useAtomSubscribe(query, receiveSnapshot, { immediate: true });
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
    <Button label="Frühere Gespräche" tone="text" onPress={() => setExpanded(true)} />
  );
}

function EarlierCallsPage({ environmentId, threadId, before, register }: EarlierCallsProps) {
  const atom = earlierVoiceCallHistoryQuery({ environmentId, input: { threadId, before } });
  const receiveCalls = useCallback(
    (result: Atom.Type<typeof atom>) => {
      const calls = AsyncResult.isFailure(result)
        ? null
        : AsyncResult.getOrElse(result, () => null)?.calls;
      if (calls) register(calls);
    },
    [register],
  );
  useAtomSubscribe(atom, receiveCalls, { immediate: true });
  const query = useEnvironmentQuery(atom);
  if (query.error)
    return (
      <HistoryError text="Frühere Gespräche konnten nicht geladen werden." retry={query.refresh} />
    );
  if (!query.data)
    return (
      <AppText className="py-2 text-xs text-foreground-muted">Gespräche werden geladen…</AppText>
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

function HistoryError({ text, retry }: { readonly text: string; readonly retry: () => void }) {
  return (
    <View className="flex-row flex-wrap items-center gap-2 py-2">
      <AppText accessibilityRole="alert" className="text-xs text-foreground-muted">
        {text}
      </AppText>
      <Button label="Erneut versuchen" tone="text" onPress={retry} />
    </View>
  );
}

export function NativeVoiceCallHistory({
  environmentId,
  threadId,
  children,
}: HistoryProps & {
  readonly children: (
    items: ReadonlyArray<VoiceConversationItem>,
    controls: ReactNode,
  ) => ReactNode;
}) {
  const query = useEnvironmentQuery(voiceCallHistoryQuery({ environmentId, input: { threadId } }));
  const [retained, setRetained] = useState<ReadonlyArray<LiveVoiceCallSummary>>([]);
  const [transcripts, setTranscripts] = useState<ReadonlyMap<string, Snapshot>>(new Map());
  const observedCalls = useNativeVoiceObserved();
  const observed = useMemo(
    () =>
      observedCalls.filter(
        (value) => value.environmentId === environmentId && value.call.threadId === threadId,
      ),
    [observedCalls, environmentId, threadId],
  );
  const { enabled: bubbles } = useNativeVoiceBubbleView();
  const incoming = query.error ? null : query.data?.calls;
  const registerCalls = useCallback(
    (calls: ReadonlyArray<LiveVoiceCallSummary>) =>
      setRetained((previous) => retainVoiceCalls(previous, calls)),
    [],
  );
  const registerTranscript = useCallback(
    (key: string, snapshot: Snapshot) =>
      setTranscripts((previous) =>
        previous.get(key) === snapshot ? previous : new Map(previous).set(key, snapshot),
      ),
    [],
  );
  const calls = useMemo(
    () => (query.error ? [] : retainVoiceCalls(retained, incoming ?? [])),
    [query.error, retained, incoming],
  );
  if (!query.error && calls !== retained) setRetained(calls);
  const items = useMemo(() => {
    const received = voiceConversationItems(calls, transcripts, observed);
    return bubbles ? voiceSpeechBubbles(received, { environmentId, threadId }) : received;
  }, [calls, transcripts, observed, bubbles, environmentId, threadId]);
  const controls = (
    <View>
      {items.length > 0 && <NativeVoiceBubbleViewToggle />}
      {query.error ? (
        <HistoryError text="Gesprächsverlauf konnte nicht geladen werden." retry={query.refresh} />
      ) : (
        <>
          {query.data?.persistenceAvailable === false && (
            <AppText accessibilityRole="alert" className="py-2 text-xs text-danger">
              Der Gesprächsverlauf konnte nicht vollständig gespeichert werden.
            </AppText>
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
    </View>
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
      {children(items, controls)}
    </>
  );
}
