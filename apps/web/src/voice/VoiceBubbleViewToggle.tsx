import { useId } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { Switch } from "~/components/ui/switch";

export function useVoiceBubbleView() {
  return useLocalStorage("t3code:voice-bubbles-experimental", false, Schema.Boolean);
}

export function VoiceBubbleViewToggle() {
  const [enabled, setEnabled] = useVoiceBubbleView();
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground">
      <Switch id={id} size="sm" checked={enabled} onCheckedChange={setEnabled} />
      <label htmlFor={id}>Speech bubbles · Experimental</label>
      <span>{enabled ? "On" : "Off · Original transcript"}</span>
    </div>
  );
}
