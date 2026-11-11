import type { TimelineViewport } from "./timelineViewport";

export type TimelineScrollCommand =
  | { readonly kind: "line" | "page"; readonly direction: -1 | 1 }
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "message"; readonly number: number };

const timelines = new Map<HTMLElement, (command: TimelineScrollCommand) => void>();
const CONVERSATION = '[data-workspace-area="conversation"],[data-keyboard-region="Conversation"]';

export function resolveTimelineScrollCommand(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): TimelineScrollCommand | null {
  if (event.metaKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey) {
    return !event.shiftKey && (key === "d" || key === "u")
      ? { kind: "page", direction: key === "d" ? 1 : -1 }
      : null;
  }
  if (key === "g") return { kind: event.shiftKey ? "end" : "start" };
  if (!event.shiftKey && (key === "j" || key === "k")) {
    return { kind: "line", direction: key === "j" ? 1 : -1 };
  }
  return null;
}

export function timelineKeyboardScrollTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const region = target.closest(CONVERSATION);
  const fromAppNavigation =
    target === document.body ||
    target === document.documentElement ||
    target.closest('[aria-label="App navigation"]') !== null;
  for (const node of timelines.keys()) {
    if (!node.isConnected || !node.checkVisibility({ visibilityProperty: true })) continue;
    if (
      node.contains(target) ||
      (region !== null && node.closest(CONVERSATION) === region) ||
      (fromAppNavigation && !node.closest("[data-side-chat-pane]"))
    ) {
      return node;
    }
  }
  return null;
}

export function scrollTimelineFromKeyboard(
  target: EventTarget | null,
  command: TimelineScrollCommand,
): boolean {
  const node = timelineKeyboardScrollTarget(target);
  const scroll = node ? timelines.get(node) : undefined;
  if (!scroll) return false;
  scroll(command);
  return true;
}

export function registerTimelineKeyboardScroll(
  viewport: TimelineViewport,
  options: {
    readonly scrollToEnd: () => void;
    readonly getScrollPaddingBottomPx: () => number;
    readonly releasesFollow: (direction: -1 | 1) => boolean;
  },
): () => void {
  const node = viewport.scrollNode;
  const previousTabIndex = node.getAttribute("tabindex");
  if (previousTabIndex === null) node.tabIndex = -1;
  timelines.set(node, (command) => {
    // Row recycling must not move keyboard ownership to body (or another chat).
    node.focus({ preventScroll: true });
    if (command.kind === "message") {
      viewport.navigate({ releasesFollow: true });
      viewport.jumpToMessage?.(command.number);
      return;
    }
    if (command.kind === "end") {
      options.scrollToEnd();
      return;
    }
    const style = getComputedStyle(node);
    const lineHeight =
      Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 24;
    const step =
      command.kind === "page"
        ? Math.max(1, node.clientHeight - options.getScrollPaddingBottomPx()) / 2
        : lineHeight;
    const top = command.kind === "start" ? 0 : node.scrollTop + step * command.direction;
    const offset = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, top));
    viewport.navigate({
      releasesFollow:
        offset !== node.scrollTop &&
        options.releasesFollow(command.kind === "start" ? -1 : command.direction),
    });
    // Immediate steps accumulate under key repeat instead of restarting a smooth scroll.
    node.scrollTop = offset;
  });
  return () => {
    timelines.delete(node);
    if (previousTabIndex === null) node.removeAttribute("tabindex");
  };
}
