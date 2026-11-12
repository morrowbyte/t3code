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
  const state = projection
    ? deriveComputerUseStatus({
        items: computerUseProjectionItems(projection, runId),
        runId,
        isWorking,
        confirmed: connectionState === "connected" && syncStatus === "live" && contentReady,
      })
    : null;
  if (!state) return null;
  return (
    <View className="gap-1 border-b border-border px-3 py-2">
      <Text accessibilityLiveRegion="polite" className="text-xs font-t3-medium">
        {state.target ?? "Computer Use"}
        {" · "}
        <Text className={state.failed ? "text-danger-foreground" : "text-foreground-muted"}>
          {state.phase}
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
