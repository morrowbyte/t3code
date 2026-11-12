import { CheckIcon, XIcon } from "lucide-react";
import type { Ref } from "react";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";

const steps = [
  { id: "escape", keys: "Esc", label: "Leave the composer" },
  { id: "commands", keys: "Space", label: "Open keyboard commands" },
  { id: "sidebar", keys: "S F", label: "Focus the thread list" },
  { id: "help", keys: "?", label: "Open help for the focused thread" },
  { id: "composer", keys: "Esc, then I", label: "Return to writing" },
] as const;

export type KeyboardPracticeStep = (typeof steps)[number]["id"] | "complete";

export function KeyboardPractice({
  step,
  onClose,
  ref,
}: {
  step: KeyboardPracticeStep;
  onClose: () => void;
  ref: Ref<HTMLDivElement>;
}) {
  const index = steps.findIndex((item) => item.id === step);
  const current = steps[index];
  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-label="Keyboard practice"
      className="flex max-w-full items-center gap-2 rounded-md border bg-popover px-2 py-1.5 text-sm text-popover-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {current ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">{index + 1}/5</span>
            <Kbd>{current.keys}</Kbd>
            <span>{current.label}</span>
          </>
        ) : (
          <>
            <CheckIcon aria-hidden className="size-4 text-success-foreground" />
            <span>Keyboard practice complete</span>
          </>
        )}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={step === "complete" ? "Dismiss keyboard practice" : "Stop keyboard practice"}
        onClick={onClose}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}
