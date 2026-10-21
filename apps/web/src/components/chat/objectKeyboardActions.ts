import type { KeyboardEvent } from "react";

export function handleObjectActionKey(
  event: KeyboardEvent<HTMLElement>,
  shortcuts: Readonly<Record<string, string>>,
): boolean {
  if (
    event.target !== event.currentTarget ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229
  )
    return false;
  const action = shortcuts[event.key];
  if (!action) return false;
  const control = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("[data-keyboard-action]"),
  ].find(
    (element) =>
      element.dataset.keyboardAction === action &&
      element.closest("[data-keyboard-object]") === event.currentTarget &&
      !element.matches(":disabled, [aria-disabled=true]") &&
      !element.closest("[inert], [hidden], [aria-hidden=true]"),
  );
  if (!control) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) control.click();
  return true;
}
