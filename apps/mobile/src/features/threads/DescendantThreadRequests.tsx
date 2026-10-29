import { useAtomValue } from "@effect/atom-react";
import {
  createDescendantThreadRequestsAtom,
  type DescendantThreadRequests as RequestGroup,
} from "@t3tools/client-runtime/state/descendant-thread-requests";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { useState } from "react";
import { useDerivedValue } from "react-native-reanimated";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { useThreadRequests } from "../../state/use-selected-thread-requests";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const requestsAtom = createDescendantThreadRequestsAtom({
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  pendingRequestsAtom: environmentThreadDetails.pendingRequestsAtom,
  statusAtom: environmentThreadDetails.statusAtom,
});

function RequestCard(props: {
  readonly group: RequestGroup;
  readonly requestId: RuntimeRequestId;
  readonly canOperate: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const maxHeight = useDerivedValue(() => 320);
  const { connectedEnvironments } = useRemoteConnections();
  const environmentLabel = connectedEnvironments.find(
    (entry) => entry.environmentId === props.group.origin.environmentId,
  )?.environmentLabel;
  const request = useThreadRequests(props.group.origin, props.group.requests, {
    requestId: props.requestId,
    requireLive: true,
  });
  return (
    <View className="gap-3">
      {request.activePendingApproval ? (
        <PendingApprovalCard
          approval={request.activePendingApproval}
          environmentId={props.group.origin.environmentId}
          environmentLabel={environmentLabel}
          runtimeMode={props.group.runtimeMode}
          canOperateThread={props.canOperate}
          respondingApprovalId={request.respondingApprovalId}
          onRespond={request.onRespondToApproval}
        />
      ) : null}
      {request.activePendingUserInput ? (
        <PendingUserInputCard
          origin={props.group.origin}
          environmentId={props.group.origin.environmentId}
          pendingUserInput={request.activePendingUserInput}
          maxHeight={maxHeight}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          canOperateThread={props.canOperate}
          drafts={request.activePendingUserInputDrafts}
          answers={request.activePendingUserInputAnswers}
          respondingUserInputId={request.respondingUserInputId}
          onSelectOption={request.onSelectUserInputOption}
          onChangeCustomAnswer={request.onChangeUserInputCustomAnswer}
          onSubmit={request.onSubmitUserInput}
          onDismiss={request.onDismissUserInput}
        />
      ) : null}
    </View>
  );
}

function OriginRequests(props: {
  readonly group: RequestGroup;
  readonly canOperate: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { group } = props;
  const requests = group.requests;
  const requestIds = requests
    ? [...requests.approvals, ...requests.userInputs].map((entry) => entry.requestId)
    : [];
  return (
    <View className="gap-2 rounded-2xl border border-border bg-card-alt p-3">
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open thread ${group.title}`}
          className="min-h-12 min-w-0 flex-1 justify-center"
          onPress={() => props.onOpenThread(group.origin)}
        >
          <Text className="font-t3-bold text-sm text-foreground">{group.title} ↗</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} requests from ${group.title}`}
          accessibilityState={{ expanded }}
          className="min-h-12 min-w-12 items-center justify-center"
          onPress={() => setExpanded((value) => !value)}
        >
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={18}
            tintColorClassName="accent-icon"
          />
        </Pressable>
      </View>
      {requests === null ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          Synchronizing requests…
        </Text>
      ) : (
        <Text className="text-xs text-foreground-muted">
          {requests.userInputs.length} questions · {requests.approvals.length} approvals
        </Text>
      )}
      <View style={expanded ? undefined : { display: "none" }}>
        {requestIds.map((requestId) => (
          <RequestCard
            key={requestId}
            group={group}
            requestId={requestId}
            canOperate={props.canOperate}
          />
        ))}
      </View>
    </View>
  );
}

export function DescendantThreadRequestGroups(props: {
  readonly groups: ReadonlyArray<RequestGroup>;
  readonly canOperate: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  if (props.groups.length === 0) return null;
  return (
    <ScrollView
      style={{ maxHeight: 440 }}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-3 px-4 pb-3"
    >
      {props.groups.map((group) => (
        <OriginRequests
          key={`${group.origin.environmentId}:${group.origin.threadId}`}
          group={group}
          canOperate={props.canOperate}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </ScrollView>
  );
}

export function DescendantThreadRequests(props: { readonly parent: ScopedThreadRef }) {
  const groups = useAtomValue(requestsAtom(props.parent));
  const canOperate = useEnvironmentScope(props.parent.environmentId, AuthOrchestrationOperateScope);
  const openLinkedThread = useOpenLinkedThread();
  return (
    <DescendantThreadRequestGroups
      groups={groups}
      canOperate={canOperate}
      onOpenThread={openLinkedThread}
    />
  );
}
