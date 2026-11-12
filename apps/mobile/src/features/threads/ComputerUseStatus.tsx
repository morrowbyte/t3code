import { useAtomValue } from "@effect/atom-react";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import {
  computerUseElapsed,
  computerUseProjectionItems,
  deriveComputerUseStatus,
  type ComputerUseStatusState,
} from "@t3tools/client-runtime/work-log/computer-use-status";
import { View } from "react-native";
import { Atom } from "effect/reactivity";
import { AppText as Text } from "../../components/ui/AppText";
import { environmentThreadDetails } from "../../state/threads";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { useEnvironmentQuery } from "../../state/query";
import { orchestrationEnvironment } from "../../state/orchestration";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { resolveComputerObservationItem } from "@t3tools/client-runtime/work-log/computer-observation-receipt";
import {
  computerInputState,
  isNativeInputTool,
} from "@t3tools/client-runtime/work-log/computer-input-receipt";

const NO_THREAD = Atom.make<EnvironmentThread | null>(null);

export function ComputerUseStatus({
  detailRef,
  runId,
  isWorking,
  connectionState,
  syncStatus,
  contentReady,
}: {
  readonly detailRef: ScopedThreadRef | null;
  readonly runId: RunId | null;
  readonly isWorking: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly syncStatus: EnvironmentThreadStatus | undefined;
  readonly contentReady: boolean;
}) {
  const projection = useAtomValue(
    detailRef === null ? NO_THREAD : environmentThreadDetails.threadAtom(detailRef),
    (thread) => thread?.projection ?? null,
  );
  const projectionConfirmed =
    connectionState === "connected" && syncStatus === "live" && contentReady;
  const state = projection
    ? deriveComputerUseStatus({
        items: computerUseProjectionItems(projection, runId),
        runId,
        isWorking,
        confirmed: projectionConfirmed,
      })
    : null;
  const wire = state?.inputItem;
  const detail = useEnvironmentQuery(
    projectionConfirmed &&
      detailRef &&
      wire &&
      isNativeInputTool(wire.toolName) &&
      !["pending", "running", "waiting"].includes(wire.status) &&
      wire.outputOmitted
      ? orchestrationEnvironment.turnItem({
          environmentId: detailRef.environmentId,
          input: {
            threadId: wire.threadId,
            itemId: wire.id,
            revision: turnItemDetailRevision(wire),
          },
        })
      : null,
  );
  const resolved = wire
    ? resolveComputerObservationItem(wire, detail.data?.item, Boolean(detail.error))
    : null;
  const input =
    projectionConfirmed && resolved?.type === "dynamic_tool"
      ? computerInputState(resolved)
      : state?.input;
  if (!state || !input) return null;
  return (
    <View className="gap-1 border-b border-border px-3 py-2">
      <Text accessibilityLiveRegion="polite" className="text-xs font-t3-medium">
        {state.target ?? "Computer Use"}
        {" · "}
        <Text className={state.failed ? "text-danger-foreground" : "text-foreground-muted"}>
          {state.phase}
        </Text>
        {"\n"}
        <Text className="text-foreground-muted">
          {input.target && input.target !== state.target ? `${input.target} · ` : ""}
          {input.label}
        </Text>
      </Text>
      {state.action ? (
        <Text numberOfLines={2} className="text-xs text-foreground-muted">
          {state.action}
        </Text>
      ) : null}
      <ComputerUseTime state={state} />
    </View>
  );
}

function ComputerUseTime({ state }: { readonly state: ComputerUseStatusState }) {
  const now = useVisibleSecondClock(true);
  return (
    <Text className="text-xs tabular-nums text-foreground-muted">
      {state.live && state.startedAt !== null
        ? `Phase ${computerUseElapsed(state.startedAt, now)} · `
        : ""}
      Last event {computerUseElapsed(state.lastEventAt, now)} ago
    </Text>
  );
}
