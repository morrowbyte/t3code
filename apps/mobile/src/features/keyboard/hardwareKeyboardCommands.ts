import { EnvironmentId, ThreadId, type ThreadJumpKeybindingCommand } from "@t3tools/contracts";
import { useEffect } from "react";
import type { CommandPaletteItem } from "./commandPaletteItems";

export type HardwareKeyboardCommand =
  | ThreadJumpKeybindingCommand
  | "commandPalette"
  | "keyboardNavigation"
  | "composerFocus"
  | "composerEscape"
  | "paletteNext"
  | "palettePrevious"
  | "paletteDismiss"
  | "newTask"
  | "focusSearch"
  | "back"
  | "files"
  | "terminal"
  | "review"
  | "copyThreadReference"
  | "toggleSidebar"
  | "cycleHost";

type CommandHandler = (command: HardwareKeyboardCommand) => boolean | void;

const handlers = new Map<HardwareKeyboardCommand, Set<CommandHandler>>();
const paletteItems = new Map<symbol, ReadonlyArray<CommandPaletteItem>>();
let paletteSnapshot: ReadonlyArray<CommandPaletteItem> = [];
const registrationListeners = new Set<() => void>();
let registrationVersion = 0;

export function useHardwareKeyboardCommand(
  command: HardwareKeyboardCommand | ReadonlyArray<HardwareKeyboardCommand>,
  handler: CommandHandler,
): void {
  useEffect(() => {
    const commands = typeof command === "string" ? [command] : command;
    for (const command of commands) {
      const commandHandlers = handlers.get(command) ?? new Set<CommandHandler>();
      commandHandlers.add(handler);
      handlers.set(command, commandHandlers);
    }
    registrationVersion += 1;
    registrationListeners.forEach((listener) => listener());
    return () => {
      for (const command of commands) {
        const commandHandlers = handlers.get(command);
        commandHandlers?.delete(handler);
        if (commandHandlers?.size === 0) handlers.delete(command);
      }
      registrationVersion += 1;
      registrationListeners.forEach((listener) => listener());
    };
  }, [command, handler]);
}

export function useHardwareKeyboardPaletteItems(
  items: ReadonlyArray<CommandPaletteItem>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const owner = Symbol();
    paletteItems.set(owner, items);
    paletteSnapshot = [...paletteItems.values()].flat();
    registrationVersion += 1;
    registrationListeners.forEach((listener) => listener());
    return () => {
      paletteItems.delete(owner);
      paletteSnapshot = [...paletteItems.values()].flat();
      registrationVersion += 1;
      registrationListeners.forEach((listener) => listener());
    };
  }, [items, enabled]);
}

export function getRegisteredHardwareKeyboardPaletteItems(): ReadonlyArray<CommandPaletteItem> {
  return paletteSnapshot;
}

export function getRegisteredHardwareKeyboardCommands(): ReadonlySet<HardwareKeyboardCommand> {
  return new Set(handlers.keys());
}

export function getHardwareKeyboardCommandRegistrationVersion(): number {
  return registrationVersion;
}

export function subscribeToHardwareKeyboardCommandRegistrations(listener: () => void): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

export function dispatchHardwareKeyboardCommand(command: HardwareKeyboardCommand): boolean {
  const commandHandlers = handlers.get(command);
  if (!commandHandlers) return false;
  const handlersInRegistrationOrder = Array.from(commandHandlers);
  for (let index = handlersInRegistrationOrder.length - 1; index >= 0; index -= 1) {
    const handler = handlersInRegistrationOrder[index];
    if (!handler) continue;
    if (handler(command) !== false) return true;
  }
  return false;
}

export function parseActiveThreadPath(pathname: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
} | null {
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      environmentId: EnvironmentId.make(decodeURIComponent(match[1])),
      threadId: ThreadId.make(decodeURIComponent(match[2])),
    };
  } catch {
    return null;
  }
}

export function nextEnvironmentId<T extends { readonly environmentId: string }>(
  environments: ReadonlyArray<T>,
  currentId: string | null,
): T["environmentId"] | null {
  if (environments.length < 2) return null;
  const index = environments.findIndex((environment) => environment.environmentId === currentId);
  return environments[(index + 1) % environments.length]?.environmentId ?? null;
}
