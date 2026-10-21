import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function treeNavigationKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  if (
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return false;
  const path = event.nativeEvent.composedPath();
  if (
    path.some(
      (node) => node instanceof Element && node.matches('input,textarea,[contenteditable="true"]'),
    )
  )
    return false;
  if (
    !path.some(
      (node) =>
        node instanceof Element &&
        (node.matches('[role="tree"],[role="treeitem"],file-tree-container') ||
          node.hasAttribute("data-item-path")),
    )
  )
    return false;
  const key = (
    { j: "ArrowDown", k: "ArrowUp", h: "ArrowLeft", l: "ArrowRight" } as Record<string, string>
  )[event.key];
  const target = path[0];
  if (!key || !(target instanceof Element)) return false;
  event.preventDefault();
  event.stopPropagation();
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }),
  );
  return true;
}
