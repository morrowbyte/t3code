import { isEditableFocused } from "../../lib/editableFocus";
import { focusElement } from "./LeaderNavigation.dom";
import type { WorkbenchCommand } from "./WorkbenchCommandPicker";

const REGION_SELECTOR =
  "[data-app-sidebar],[data-chat-composer-main-surface],[data-right-panel-surface-content],[data-right-panel-tabbar],[data-leader-message-focus]";
const CONTROL_SELECTOR =
  "button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex='0'],[role='treeitem']";

function visible(element: HTMLElement): boolean {
  return (
    !element.closest("[hidden],[inert],[aria-hidden=true]") &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
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
  const regions = [...document.querySelectorAll<HTMLElement>(REGION_SELECTOR)].filter(visible);
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
  const region = target instanceof Element ? target.closest(REGION_SELECTOR) : null;
  const root = region ?? document.querySelector("[data-right-panel-surface-content]") ?? document;
  return [...root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)]
    .filter((control) => visible(control) && !control.closest("[data-leader-key]"))
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
          detail: isEditableFocused(control) ? "Focus input" : "Focus control · Enter to activate",
          run: () => {
            focusElement(control);
          },
        },
      ];
    });
}
