import {
  LIVE_VOICE_ACTIVITY_LIMIT,
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
  if (!activities.length && !liveActivities.length) return null;
  return (
    <section aria-label="Voice call activity" className="min-w-0 basis-full py-2">
      <div className="max-h-40 space-y-2 overflow-y-auto">
        {liveActivities.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">
              GPT Live · Recent tool activity (up to {LIVE_VOICE_ACTIVITY_LIMIT})
            </p>
            <div className="space-y-2">
              {liveActivities.map((activity) => (
                <div
                  key={activity.id}
                  className="rounded-xl border border-border bg-muted/40 px-3 py-2"
                >
                  <p className="text-xs text-muted-foreground">
                    {
                      {
                        started: "Started",
                        running: "Running",
                        waiting: "Waiting",
                        completed: "Completed",
                        failed: "Failed",
                        interrupted: "Interrupted",
                      }[activity.status]
                    }
                  </p>
                  <p className="text-sm wrap-anywhere">{liveVoiceActivityLabel(activity.action)}</p>
                </div>
              ))}
            </div>
          </>
        ) : null}
        {activities.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">
              Thread activity · Results and requests in chat
            </p>
            <div className="space-y-2">
              {activities.map((activity) => (
                <div
                  key={activity.id}
                  className="rounded-xl border border-border bg-muted/40 px-3 py-2"
                >
                  <p className="text-xs text-muted-foreground">
                    {activity.status === "pending"
                      ? "Queued"
                      : activity.status === "waiting"
                        ? "Waiting"
                        : "Running"}
                  </p>
                  <p className="text-sm wrap-anywhere">{activity.label}</p>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
