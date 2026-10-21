import { isEditableFocused } from "../../lib/editableFocus";
import { focusElement } from "./LeaderNavigation.dom";
import type { WorkbenchCommand } from "./WorkbenchCommandPicker";

const REGION_SELECTOR =
  "[data-keyboard-region],[data-app-sidebar],[data-chat-composer-main-surface],[data-right-panel-surface-content],[data-right-panel-tabbar],[data-slot=dialog-popup],[data-slot=sheet-popup]";
const CONTROL_SELECTOR =
  "button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[role=menuitem],[role=checkbox],[role=switch],[role=tab],[tabindex='0'],[role='treeitem']";
const OBJECT_SELECTOR =
  "[data-keyboard-object],[data-message-id][data-message-role],[data-thread-item]";

function visible(element: HTMLElement): boolean {
  return (
    !element.closest("[hidden],[inert],[aria-hidden=true]") &&
    element.getClientRects().length > 0 &&
    element.checkVisibility({ visibilityProperty: true })
  );
}

export function focusWorkbenchRegion(selector: string): void {
  requestAnimationFrame(() => {
    const region = document.querySelector<HTMLElement>(selector);
    if (!region || !visible(region) || region.contains(document.activeElement)) return;
    const control = [...region.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].find(visible);
    if (control) focusElement(control);
    else {
      region.tabIndex = -1;
      focusElement(region);
    }
  });
}

export function cycleWorkbenchRegion(direction: -1 | 1): boolean {
  const visibleRegions = [...document.querySelectorAll<HTMLElement>(REGION_SELECTOR)].filter(
    visible,
  );
  const regions = visibleRegions.filter(
    (region) => !visibleRegions.some((other) => other !== region && region.contains(other)),
  );
  if (!regions.length) return false;
  const current = regions.findIndex((region) => region.contains(document.activeElement));
  const next =
    regions[
      current < 0
        ? direction > 0
          ? 0
          : regions.length - 1
        : (current + direction + regions.length) % regions.length
    ];
  if (!next) return false;
  const control = [...next.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].find(visible);
  if (control) return focusElement(control);
  next.tabIndex = -1;
  return focusElement(next);
}

export function contextControls(
  target: Element | null = document.activeElement,
): WorkbenchCommand[] {
  const root = keyboardContextRoot(target);
  const controls = [...root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)];
  if (root instanceof HTMLElement && root.matches(CONTROL_SELECTOR)) controls.unshift(root);
  return controls
    .filter(
      (control) =>
        visible(control) &&
        control.matches(
          "button,a[href],input,textarea,select,summary,[role=button],[role=menuitem],[role=checkbox],[role=switch],[role=radio],[role=tab],[role=combobox],[role=treeitem]",
        ) &&
        !control.matches('[aria-disabled="true"],:disabled') &&
        !control.closest("[data-leader-key]"),
    )
    .flatMap((control, index) => {
      const label =
        control.getAttribute("aria-label") ??
        control.getAttribute("title") ??
        control.textContent?.trim();
      if (!label) return [];
      return [
        {
          id: String(index),
          label: label.slice(0, 200),
          detail: isEditableFocused(control) ? "Edit input" : "Run action",
          run: () => {
            if (!control.isConnected || control.matches(':disabled,[aria-disabled="true"]')) return;
            focusElement(control);
            if (!isEditableFocused(control)) control.click();
          },
        },
      ];
    });
}

export function keyboardContextRoot(target: Element | null = document.activeElement): ParentNode {
  if (target instanceof Element) {
    const object = target.closest(OBJECT_SELECTOR);
    if (object) return object;
    const region = target.closest(REGION_SELECTOR);
    if (region) return region;
  }
  return (
    document.querySelector("[data-leader-message-focus]") ??
    document.querySelector("[data-right-panel-surface-content]") ??
    document.querySelector("main") ??
    document
  );
}

export function keyboardContextName(target: Element | null = document.activeElement): string {
  const root = keyboardContextRoot(target);
  if (!(root instanceof HTMLElement)) return "App";
  if (root.dataset.keyboardObject) return root.dataset.keyboardObject;
  if (root.dataset.messageRole) return `${root.dataset.messageRole} message`;
  if (root.hasAttribute("data-thread-item")) return "Thread";
  return root.getAttribute("aria-label") ?? root.dataset.keyboardRegion ?? "App";
}

export function hasLocalKeyboardNavigation(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof Element &&
        node.matches(
          "[role=tree],[role=treeitem],[role=application],[data-keyboard-local],[data-keybinding-capture],.file-tree-container,.monaco-editor,.cm-editor,.xterm,[data-terminal-id]",
        ),
    );
}

export function moveKeyboardObject(target: Element | null, direction: -1 | 1): boolean {
  if (!target) return false;
  const current = target.closest<HTMLElement>(OBJECT_SELECTOR);
  const region = target.closest(REGION_SELECTOR) ?? document.querySelector("main") ?? document;
  const kind = current?.dataset.keyboardObject;
  const items = [...region.querySelectorAll<HTMLElement>(OBJECT_SELECTOR)].filter(
    (element) =>
      visible(element) &&
      (kind !== undefined
        ? element.dataset.keyboardObject === kind
        : current?.hasAttribute("data-message-id")
          ? element.hasAttribute("data-message-id")
          : current?.hasAttribute("data-thread-item")
            ? element.hasAttribute("data-thread-item")
            : element.parentElement?.closest(OBJECT_SELECTOR) === null),
  );
  if (!items.length) return false;
  const index = current ? items.indexOf(current) : -1;
  const next =
    items[
      index < 0
        ? direction > 0
          ? 0
          : items.length - 1
        : (index + direction + items.length) % items.length
    ];
  if (!next) return false;
  if (!next.hasAttribute("tabindex")) next.tabIndex = -1;
  return focusElement(next);
}

export function activateKeyboardObject(target: Element | null): boolean {
  const object = target?.closest<HTMLElement>(OBJECT_SELECTOR);
  if (!object || target !== object) return false;
  const primary = object.matches("[data-keyboard-primary]")
    ? object
    : object.querySelector<HTMLElement>("[data-keyboard-primary]");
  if (!primary || !visible(primary) || primary.matches(':disabled,[aria-disabled="true"]'))
    return false;
  focusElement(primary);
  primary.click();
  return true;
}
