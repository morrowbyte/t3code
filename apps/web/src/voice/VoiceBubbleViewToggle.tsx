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
    <div className="flex items-center justify-between gap-3 text-sm">
      <label htmlFor={id}>Speech bubbles</label>
      <Switch id={id} size="sm" checked={enabled} onCheckedChange={setEnabled} />
    </div>
  );
}
