import { useAtomValue } from "@effect/atom-react";
import {
  LIVE_VOICE_ACTIVITY_LIMIT,
  liveVoiceActivityLabel,
} from "@t3tools/shared/liveVoiceActivity";
import type { LiveVoiceActivity, ScopedThreadRef } from "@t3tools/contracts";
import { activeVoiceToolActivities } from "@t3tools/client-runtime/live-voice/activity";
import { ScrollView, View } from "react-native";
import { environmentThreadDetails } from "../../state/threads";
import { AppText } from "../../components/ui/AppText";

export function NativeVoiceActivityBubbles({
  threadRef,
  liveActivities = [],
}: {
  readonly threadRef: ScopedThreadRef;
  readonly liveActivities?: ReadonlyArray<LiveVoiceActivity>;
}) {
  const rows = useAtomValue(environmentThreadDetails.quietVisibleTurnItemsAtom(threadRef));
  const activities = activeVoiceToolActivities(rows, threadRef);
  if (!activities.length && !liveActivities.length) return null;
  return (
    <View accessibilityLabel="Gesprächsaktivität" className="py-2">
      <ScrollView className="max-h-40" nestedScrollEnabled>
        <View className="gap-2">
          {liveActivities.length > 0 ? (
            <>
              <AppText className="text-xs text-foreground-muted">
                GPT Live · Letzte Toolaktivitäten (bis zu {LIVE_VOICE_ACTIVITY_LIMIT})
              </AppText>
              <View>
                {liveActivities.map((activity) => (
                  <View
                    key={activity.id}
                    className="mb-2 rounded-xl border border-border bg-subtle px-3 py-2"
                  >
                    <AppText className="text-xs text-foreground-muted">
                      {
                        {
                          started: "Gestartet",
                          running: "Läuft",
                          waiting: "Wartet",
                          completed: "Abgeschlossen",
                          failed: "Fehlgeschlagen",
                          interrupted: "Unterbrochen",
                        }[activity.status]
                      }
                    </AppText>
                    <AppText className="text-sm text-foreground">
                      {liveVoiceActivityLabel(activity.action, "de")}
                    </AppText>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {activities.length > 0 ? (
            <>
              <AppText className="text-xs text-foreground-muted">
                Thread-Aktivität · Ergebnisse und Rückfragen im Chat
              </AppText>
              <View>
                {activities.map((activity) => (
                  <View
                    key={activity.id}
                    className="mb-2 rounded-xl border border-border bg-subtle px-3 py-2"
                  >
                    <AppText className="text-xs text-foreground-muted">
                      {activity.status === "pending"
                        ? "Vorgemerkt"
                        : activity.status === "waiting"
                          ? "Wartet"
                          : "Läuft"}
                    </AppText>
                    <AppText className="text-sm text-foreground">{activity.label}</AppText>
                  </View>
                ))}
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
