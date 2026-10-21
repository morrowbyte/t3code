import { isEditableFocused } from "../../lib/editableFocus";
import { isContextMenuOpen } from "../../contextMenuFallback";

export const LEADER_OPEN_EVENT = "t3code:leader-navigation-open";
export const requestLeaderNavigation = () => window.dispatchEvent(new Event(LEADER_OPEN_EVENT));

const INTERACTIVE =
  "button,a[href],input,textarea,select,summary,video,audio,[role=button],[role=combobox],[role=menuitem],[role=option],[role=tab],[role=slider],[role=switch],[role=checkbox],[role=radio],[role=treeitem]";
const BLOCKED =
  "[role=dialog],[role=menu],[role=listbox],[role=application],[data-keybinding-capture],.xterm,.monaco-editor,.cm-editor,iframe";
const MESSAGE = "[data-message-id][data-message-role]";
const THREAD = "[data-thread-item] [data-testid^=sidebar-row]";

export function leaderTargetContext(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;
  return {
    editable: isEditableFocused(target),
    interactive: element?.closest(INTERACTIVE) !== null && element !== null,
    blocked: element?.closest(BLOCKED) !== null && element !== null,
  };
}

function visible(element: HTMLElement): boolean {
  return (
    !element.closest("[hidden],[inert],[aria-hidden=true]") &&
    element.getClientRects().length > 0 &&
    element.checkVisibility({ visibilityProperty: true })
  );
}

export function focusElement(element: HTMLElement | null | undefined): boolean {
  if (!element || !visible(element)) return false;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  return document.activeElement === element;
}

function elements(selector: string, root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(visible);
}

function move(items: HTMLElement[], direction: -1 | 1, current = document.activeElement): boolean {
  if (!items.length) return false;
  const index = items.findIndex((item) => item === current);
  return focusElement(
    items[
      index < 0
        ? direction > 0
          ? 0
          : items.length - 1
        : (index + direction + items.length) % items.length
    ],
  );
}

export function moveMenu(direction: -1 | 1): boolean {
  if (moveContextMenu(direction)) return true;
  const menu = elements('[role="menu"]').at(-1);
  return (
    menu !== undefined &&
    menu.contains(document.activeElement) &&
    move(
      elements('[role^="menuitem"]:not([aria-disabled="true"]):not([disabled])', menu),
      direction,
    )
  );
}

export function moveContextMenu(direction: -1 | 1): boolean {
  if (!isContextMenuOpen()) return false;
  const menu = elements(".dropdown-glass[data-level]").at(-1);
  return menu !== undefined && move(elements("button:not([disabled])", menu), direction);
}

export function movePalette(direction: -1 | 1): boolean {
  const input = document.querySelector<HTMLInputElement>(
    '[data-command-palette] input[role="combobox"]',
  );
  if (!input || document.activeElement !== input) return false;
  // Reuse the palette's own filtering, virtualized selection and arrow handler.
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: direction > 0 ? "ArrowDown" : "ArrowUp",
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}

export function sidebarRows(): HTMLElement[] {
  return elements(
    `${THREAD},[data-testid="sidebar-settled-shelf-toggle"],[data-testid="sidebar-snoozed-shelf-toggle"]`,
  );
}

export function focusSidebar(): boolean {
  const rows = sidebarRows();
  return focusElement(rows.find((row) => row.getAttribute("aria-current") === "page") ?? rows[0]);
}

export function moveSidebar(direction: -1 | 1): boolean {
  return move(sidebarRows(), direction);
}

export function discloseSidebar(expand: boolean): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const toggle = active.hasAttribute("aria-expanded")
    ? active
    : active
        .closest("[data-thread-item]")
        ?.querySelector<HTMLButtonElement>(
          "button[aria-expanded][data-thread-selection-safe]:not([aria-haspopup])",
        );
  if (!toggle) return false;
  if ((toggle.getAttribute("aria-expanded") === "true") !== expand) {
    const threadKey = active.closest<HTMLElement>("[data-thread-item]")?.dataset.threadItem;
    toggle.click();
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        !threadKey ||
        (focused !== document.body &&
          !(
            focused instanceof Element &&
            focused.matches('[data-mobile="true"][data-sidebar="sidebar"]')
          ))
      )
        return;
      const row = [...document.querySelectorAll<HTMLElement>("[data-thread-item]")].find(
        (item) => item.dataset.threadItem === threadKey,
      );
      focusElement(row?.querySelector<HTMLElement>("[data-testid^=sidebar-row]"));
    });
  }
  return true;
}

export function activateAdjacentThread(direction: -1 | 1): void {
  const rows = elements(THREAD);
  const index = rows.findIndex((row) => row.getAttribute("aria-current") === "page");
  rows[index < 0 ? 0 : (index + direction + rows.length) % rows.length]?.click();
}

export function composerElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-chat-composer-main-surface="true"] [contenteditable="true"], [data-chat-composer-main-surface="true"] textarea',
  );
}

export function focusComposer(): boolean {
  if (focusElement(composerElement())) return true;
  const expand = elements('button[aria-label="Expand composer"]:not([disabled])')[0];
  if (!expand) return false;
  expand.click();
  return true;
}

export function clickVisible(selector: string): boolean {
  const element = elements(selector)[0];
  focusElement(element);
  element?.click();
  return element !== undefined;
}

export function createMessageNavigation() {
  let current: HTMLElement | null = null;
  let previousTabIndex: string | null = null;
  const clear = () => {
    if (!current) return;
    current.removeAttribute("data-leader-message-focus");
    if (previousTabIndex === null) current.removeAttribute("tabindex");
    else current.setAttribute("tabindex", previousTabIndex);
    current = null;
  };
  const select = (message: HTMLElement | undefined): boolean => {
    if (!message) return false;
    clear();
    current = message;
    previousTabIndex = message.getAttribute("tabindex");
    message.tabIndex = -1;
    message.setAttribute("data-leader-message-focus", "true");
    const object = message.matches('[data-keyboard-object="Message"]')
      ? message
      : message.querySelector<HTMLElement>('[data-keyboard-object="Message"]');
    return focusElement(object ?? message);
  };
  return {
    enter: () => select(elements(MESSAGE).at(-1)),
    move: (direction: -1 | 1) => {
      const messages = elements(MESSAGE);
      const index = current === null ? -1 : messages.indexOf(current);
      return select(messages[Math.max(0, Math.min(messages.length - 1, index + direction))]);
    },
    action: (direction: -1 | 1) =>
      current !== null &&
      move(
        elements('button:not([disabled]),a[href],[tabindex="0"]', current).filter(
          (item) => !isEditableFocused(item),
        ),
        direction,
      ),
    clear,
  };
}
