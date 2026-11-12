import { useSyncExternalStore } from "react";
import { KeyboardIcon } from "lucide-react";
import { isEditableFocused } from "../../lib/editableFocus";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { requestLeaderNavigation } from "./LeaderNavigation.dom";
import { isNavigationMode, NAVIGATION_MODE_EVENT } from "./navigationMode";

function subscribe(onChange: () => void) {
  window.addEventListener(NAVIGATION_MODE_EVENT, onChange);
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", onChange);
  return () => {
    window.removeEventListener(NAVIGATION_MODE_EVENT, onChange);
    document.removeEventListener("focusin", onChange);
    document.removeEventListener("focusout", onChange);
  };
}

function mode() {
  return isNavigationMode() ? "Normal" : isEditableFocused() ? "Input" : "Keyboard";
}

export function KeyboardModeControl() {
  const current = useSyncExternalStore(subscribe, mode, () => "Keyboard");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="compact"
            variant="ghost-muted"
            aria-label={`Keyboard controls: ${current}`}
            aria-haspopup="dialog"
            onClick={requestLeaderNavigation}
          />
        }
      >
        <KeyboardIcon aria-hidden />
        <span>{current}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {current === "Input" ? "Esc for navigation" : "Keyboard commands and practice"}
      </TooltipPopup>
    </Tooltip>
  );
}
