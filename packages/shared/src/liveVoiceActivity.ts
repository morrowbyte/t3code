import type { LiveVoiceActivity } from "@t3tools/contracts";

export const LIVE_VOICE_ACTIVITY_LIMIT = 32;

export function liveVoiceActivityIsTerminal(activity: Pick<LiveVoiceActivity, "status">) {
  return (
    activity.status === "completed" ||
    activity.status === "failed" ||
    activity.status === "interrupted"
  );
}

export function retainLiveVoiceActivity(
  previous: ReadonlyArray<LiveVoiceActivity>,
  incoming: LiveVoiceActivity,
): ReadonlyArray<LiveVoiceActivity> {
  const old = previous.find((activity) => activity.id === incoming.id);
  if (
    old &&
    (incoming.revision <= old.revision ||
      (liveVoiceActivityIsTerminal(old) && !liveVoiceActivityIsTerminal(incoming)))
  )
    return previous;
  const activity = { ...incoming, occurredAt: old?.occurredAt ?? incoming.occurredAt };
  const next = old
    ? previous.map((entry) => (entry.id === incoming.id ? activity : entry))
    : [...previous, activity];
  if (next.length > LIVE_VOICE_ACTIVITY_LIMIT) {
    const terminal = next.findIndex(
      (entry) => entry.id !== incoming.id && liveVoiceActivityIsTerminal(entry),
    );
    next.splice(terminal < 0 ? 0 : terminal, 1);
  }
  return next;
}

export function liveVoiceActivityLabel(
  action: LiveVoiceActivity["action"],
  language: "en" | "de" = "en",
) {
  switch (action) {
    case "submit-work":
      return language === "de" ? "Deine Aufgabe übergeben" : "Submit your task";
    case "read-work":
      return language === "de"
        ? "Aufgabenstatus und Ergebnisse abrufen"
        : "Check task status and available results";
    case "steer-work":
      return language === "de" ? "Laufende Aufgabe anpassen" : "Update the running task";
    case "tool-request":
      return language === "de" ? "Voice-Toolanfrage bearbeiten" : "Process a voice tool request";
  }
}
