import type { KeybindingCommand } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";

const COMMAND_EVENT = "t3code:keyboard-command";
type CommandRequest = {
  command: KeybindingCommand;
  handled: boolean;
  origin?: HTMLElement | null | undefined;
};
type KeyboardCommands = Partial<
  Record<KeybindingCommand, (origin?: HTMLElement | null) => boolean | void>
>;

export function dispatchKeyboardCommand(
  command: KeybindingCommand,
  origin?: HTMLElement | null,
): boolean {
  if (typeof window === "undefined") return false;
  const detail: CommandRequest = { command, handled: false, origin };
  window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail }));
  return detail.handled;
}

export function useKeyboardCommands(commands: KeyboardCommands) {
  const latest = useRef(commands);
  useLayoutEffect(() => {
    latest.current = commands;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<CommandRequest>).detail;
      if (detail.handled) return;
      const run = latest.current[detail.command];
      if (run && run(detail.origin) !== false) detail.handled = true;
    };
    window.addEventListener(COMMAND_EVENT, listener);
    return () => window.removeEventListener(COMMAND_EVENT, listener);
  }, []);
}
