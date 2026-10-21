import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { Button } from "../ui/button";
import { keyboardContextRoot, keyboardContextName } from "./regionNavigation";

export function KeyboardContextHelp({
  target,
  onClose,
  onActions,
}: {
  target: HTMLElement | null;
  onClose: () => void;
  onActions: () => void;
}) {
  const root = keyboardContextRoot(target);
  const localHelp =
    root instanceof HTMLElement
      ? (root.dataset.keyboardHelp ??
        target?.closest<HTMLElement>("[data-keyboard-help]")?.dataset.keyboardHelp)
      : undefined;
  const name = keyboardContextName(target);
  const keys = [
    ["Esc", "Return one level"],
    ["Space a c", `${name} actions`],
    ["F6 / Shift F6", "Next / previous app region"],
    ["i", "Write in composer"],
  ];
  if (
    root instanceof Element &&
    !target?.closest("[data-keyboard-local]") &&
    (root.matches("[data-keyboard-object],[data-message-id],[data-thread-item]") ||
      root.querySelector("[data-keyboard-object]"))
  )
    keys.unshift(["J / K", "Next / previous object"], ["Enter", "Primary action"]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        aria-label={`${name} keyboard help`}
        finalFocus={() => (target?.isConnected ? target : false)}
      >
        <DialogHeader>
          <DialogTitle>{name} keyboard help</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {keys.map(([key, label]) => (
              <div key={key} className="contents">
                <dt>
                  <Kbd>{key}</Kbd>
                </dt>
                <dd>{label}</dd>
              </div>
            ))}
          </dl>
          {localHelp ? <p className="text-sm text-muted-foreground">{localHelp}</p> : null}
          <Button onClick={onActions}>Show {name.toLowerCase()} actions</Button>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
