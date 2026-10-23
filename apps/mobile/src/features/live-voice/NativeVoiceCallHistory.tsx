import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import type { EnvironmentId, LiveVoiceCallSummary, ThreadId } from "@t3tools/contracts";
import {
  retainVoiceCalls,
  voiceCallKey,
  voiceConversationItems,
  type VoiceConversationItem,
  type VoiceTranscriptSnapshot,
} from "@t3tools/client-runtime/live-voice";
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
  const snapshot = query.error ? "error" : query.data;
  useEffect(() => {
    if (snapshot)
      register(
        voiceCallKey(call),
        snapshot === "error" ? "error" : { transcript: snapshot, throughEventId: call.lastEventId },
      );
  }, [call, register, snapshot]);
  return null;
}

function EarlierCalls({
  environmentId,
  threadId,
  before,
  register,
}: HistoryProps & {
  readonly before: string;
  readonly register: (calls: ReadonlyArray<LiveVoiceCallSummary>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const query = useEnvironmentQuery(
    expanded ? earlierVoiceCallHistoryQuery({ environmentId, input: { threadId, before } }) : null,
  );
  const calls = query.error ? null : query.data?.calls;
  useEffect(() => {
    if (calls) register(calls);
  }, [calls, register]);
  if (!expanded)
    return <Button label="Frühere Gespräche" tone="text" onPress={() => setExpanded(true)} />;
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
  const observed = useNativeVoiceObserved();
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
  const items = useMemo(
    () => (query.error ? [] : voiceConversationItems(calls, transcripts, observed)),
    [query.error, calls, transcripts, observed],
  );
  const controls = (
    <View>
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
