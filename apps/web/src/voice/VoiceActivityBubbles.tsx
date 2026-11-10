import {
  liveVoiceActivityIsTerminal,
  liveVoiceActivityLabel,
} from "@t3tools/shared/liveVoiceActivity";
import type { LiveVoiceActivity, ScopedThreadRef } from "@t3tools/contracts";
import { activeVoiceToolActivities } from "@t3tools/client-runtime/live-voice/activity";
import { useQuietThreadVisibleTurnItems } from "~/state/entities";

export function VoiceActivityBubbles({
  threadRef,
  liveActivities = [],
}: {
  readonly threadRef: ScopedThreadRef;
  readonly liveActivities?: ReadonlyArray<LiveVoiceActivity>;
}) {
  const rows = useQuietThreadVisibleTurnItems(threadRef);
  const activities = activeVoiceToolActivities(rows, threadRef);
  const live = liveActivities.filter(
    (activity) => activity.status === "failed" || !liveVoiceActivityIsTerminal(activity),
  );
  return (
    <section aria-label="Voice call activity" className="min-w-0 border-t border-border pt-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Activity</p>
      {live.length || activities.length ? (
        <ul className="max-h-40 space-y-2 overflow-y-auto text-xs">
          {live.map((activity) => (
            <li key={activity.id} className="flex items-start justify-between gap-3">
              <span className="min-w-0 wrap-anywhere">
                {liveVoiceActivityLabel(activity.action)}
              </span>
              <span
                className={
                  activity.status === "failed"
                    ? "shrink-0 text-destructive"
                    : "shrink-0 text-muted-foreground"
                }
              >
                {activity.status === "failed"
                  ? "Failed"
                  : activity.status === "waiting"
                    ? "Waiting"
                    : "Running"}
              </span>
            </li>
          ))}
          {activities.map((activity) => (
            <li key={activity.id} className="flex items-start justify-between gap-3">
              <span className="min-w-0 wrap-anywhere">{activity.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {activity.status === "pending"
                  ? "Queued"
                  : activity.status === "waiting"
                    ? "Waiting"
                    : "Running"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No active tasks</p>
      )}
    </section>
  );
}
