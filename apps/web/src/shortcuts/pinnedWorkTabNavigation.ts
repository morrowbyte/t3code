import {
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isNavigationKeyEvent } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { numericNavigationTarget } from "../pinnedWorkTabs";
import { registerCommands } from "./dispatcher";

export function registerPinnedWorkTabNavigation(input: {
  settings: () => Pick<ClientSettings, "numericNavigationMode" | "pinnedWorkTabs">;
  keybindings: () => ResolvedKeybindingsConfig;
  terminalOpen: () => boolean;
  navigate: (target: ScopedThreadRef) => void;
}) {
  return registerCommands(
    Object.fromEntries(
      THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => [
        command,
        (event: KeyboardEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const target = numericNavigationTarget(input.settings(), index, null);
          if (target) input.navigate(target);
        },
      ]),
    ),
    {
      keybindings: input.keybindings,
      context: () => ({ pinnedTabsNavigation: true, terminalOpen: input.terminalOpen() }),
      when: (event) =>
        input.settings().numericNavigationMode === "pinned-tabs" &&
        isNavigationKeyEvent(event) &&
        !event.repeat &&
        !isCommandPaletteOpen() &&
        !isModelPickerOpen() &&
        !isTerminalFocused() &&
        !(
          event.target instanceof Element &&
          event.target.closest('[data-keybinding-capture], [role="dialog"], [data-slot$="popup"]')
        ),
    },
  );
}
