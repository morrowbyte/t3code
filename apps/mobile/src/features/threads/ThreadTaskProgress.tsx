import { useAtomValue } from "@effect/atom-react";
import {
  observatoryNode,
  OBSERVATORY_TASK_LABELS,
  projectObservatoryDetails,
  projectObservatoryTask,
} from "@t3tools/client-runtime/observatory";
import { presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";
import type { OrchestrationV2ProviderGoal, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";
import { Keyboard, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { useNowAfter } from "../../lib/clock";
import { useThreadShell } from "../../state/entities";
import { environmentShell } from "../../state/shell";
import { useEnvironmentThread } from "../../state/threads";
import { resolveThreadRequestDeliveryFailure } from "./threadListV2";

export function ThreadTaskProgress(props: {
  readonly threadRef: ScopedThreadRef;
  readonly goal: OrchestrationV2ProviderGoal | null;
  readonly working: boolean;
  readonly canOperate: boolean;
  readonly onPrepareResume: () => void;
}) {
  const [open, setOpen] = useState(false);
  const threadShell = useThreadShell(props.threadRef);
  const deliveryFailure = resolveThreadRequestDeliveryFailure(threadShell);
  const goal = props.goal ? presentProviderGoal(props.goal, props.working) : null;
  return (
    <View className="rounded-xl bg-thread-canvas">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          deliveryFailure
            ? "Response delivery failed. Open warning details"
            : goal
              ? `${goal.title}: ${goal.objective}. Open task progress`
              : "Open task progress"
        }
        accessibilityState={{ expanded: open }}
        className="min-h-12 justify-center rounded-xl px-4 py-2 active:bg-subtle"
        onPress={() => {
          Keyboard.dismiss();
          setOpen(true);
        }}
      >
        <Text
          className={
            deliveryFailure
              ? "font-t3-medium text-xs text-warning-foreground"
              : "font-t3-medium text-xs text-foreground-muted"
          }
        >
          {deliveryFailure
            ? "Response delivery failed · View details"
            : goal
              ? `${goal.title} · View progress`
              : "Task progress"}
        </Text>
        {goal && (
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {goal.objective}
          </Text>
        )}
      </Pressable>
      {open && (
        <Sheet title="Task progress" onClose={() => setOpen(false)}>
          <TaskProgressDetails
            {...props}
            onPrepareResume={() => {
              setOpen(false);
              props.onPrepareResume();
            }}
          />
        </Sheet>
      )}
    </View>
  );
}

function TaskProgressDetails(props: {
  readonly threadRef: ScopedThreadRef;
  readonly working: boolean;
  readonly canOperate: boolean;
  readonly onPrepareResume: () => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(props.threadRef.environmentId));
  const thread = useEnvironmentThread(props.threadRef.environmentId, props.threadRef.threadId);
  const threadShell = useThreadShell(props.threadRef);
  const deliveryFailure = resolveThreadRequestDeliveryFailure(threadShell);
  const raw = threadShell?.source;
  const nowMs = useNowAfter(
    threadShell?.snoozedUntil ? Date.parse(threadShell.snoozedUntil) : null,
  );
  const task = useMemo(() => {
    if (!raw) return null;
    const node = observatoryNode(props.threadRef.environmentId, raw);
    const detail = projectObservatoryDetails(
      node,
      {
        environmentId: props.threadRef.environmentId,
        label: "",
        generation: shell.generation,
        status: Option.isNone(shell.error) ? "live" : "unknown",
        shell,
      },
      thread,
    );
    return projectObservatoryTask(node, [node], detail, nowMs);
  }, [props.threadRef.environmentId, raw, shell, thread, nowMs]);
  const goal = raw?.goal ? presentProviderGoal(raw.goal, props.working) : null;
  const canPrepareResume =
    goal?.canResume === true &&
    !props.working &&
    (task?.status === "paused" || task?.status === "blocked");
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 p-4 pb-8"
    >
      {deliveryFailure && (
        <View className="gap-2">
          <Text className="font-t3-medium text-warning-foreground">Response delivery failed</Text>
          <Text className="text-foreground">{deliveryFailure.message}</Text>
        </View>
      )}
      {task === null ? (
        <Text className="text-foreground-muted">
          Task details unavailable in the loaded threads.
        </Text>
      ) : (
        <>
          <Text className="font-t3-medium text-foreground">
            {OBSERVATORY_TASK_LABELS[task.status]}
          </Text>
          <Text className="text-foreground">{task.objective ?? "No goal recorded"}</Text>
          <Text className="text-xs text-foreground-muted">
            {raw?.providerInstanceId} · {raw?.modelSelection.model}
          </Text>
          {goal?.usage && <Text className="text-foreground-muted">{goal.usage}</Text>}
          {task.interruption && (task.status === "paused" || task.status === "blocked") && (
            <View className="gap-2">
              <Text className="text-foreground">{task.interruption.reason}</Text>
              {task.lastError && (
                <Text className="text-foreground">Last error: {task.lastError}</Text>
              )}
              {task.lastUpdate && (
                <View className="gap-1">
                  <Text className="font-t3-medium text-foreground">Latest agent update</Text>
                  <Text className="text-foreground">{task.lastUpdate.trim()}</Text>
                </View>
              )}
              <Text className="text-foreground-muted">{task.interruption.nextStep}</Text>
            </View>
          )}
          {task.request && (
            <View className="gap-2">
              <Text className="font-t3-medium text-foreground">
                {task.request.blocking ? "Your input needed" : "Open question"}
              </Text>
              <Text className="text-foreground">{task.request.label}</Text>
              <Text className="text-foreground-muted">
                Close progress to respond in the thread.
              </Text>
            </View>
          )}
          {!task.steps.some(
            (step) => step.status === "running" && step.text === task.currentStep,
          ) && (
            <Text className="text-foreground">
              Current: {task.currentStep ?? "No active step recorded"}
            </Text>
          )}
          {task.planStatus !== "ready" && (
            <Text className="text-foreground-muted">
              {task.planStatus === "loading"
                ? "Plan details unavailable or syncing."
                : task.planStatus === "unavailable"
                  ? "Plan outside loaded history. Load earlier activity in the thread."
                  : "No plan recorded"}
            </Text>
          )}
          {task.steps.length > 0 && (
            <View className="gap-2">
              <Text className="font-t3-medium text-foreground">
                Plan · {task.completedSteps.length} done · {task.nextSteps.length} open
              </Text>
              {task.steps.map((step) => (
                <Text key={step.id} className="text-foreground">
                  {step.status === "completed"
                    ? "Done"
                    : step.status === "running"
                      ? "Current"
                      : "Remaining"}
                  : {step.text}
                </Text>
              ))}
            </View>
          )}
          {task.plans
            .filter((plan) => plan.kind === "proposed_plan")
            .map((plan) => (
              <Text key={plan.id} className="text-foreground">
                {plan.detailInTurnItem ? "Full plan in thread activity" : plan.markdown}
              </Text>
            ))}
          {canPrepareResume && (
            <Button
              label="Prepare resume command"
              disabled={!props.canOperate}
              onPress={props.onPrepareResume}
            />
          )}
        </>
      )}
    </ScrollView>
  );
}
