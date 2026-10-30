import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ClientSettings, PinnedWorkTab } from "@t3tools/contracts/settings";

export const MAX_PINNED_WORK_TABS = 5;

export function sameWorkTab(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function togglePinnedWorkTab(
  tabs: readonly PinnedWorkTab[],
  tab: PinnedWorkTab,
): readonly PinnedWorkTab[] {
  if (tabs.some((item) => sameWorkTab(item, tab))) {
    return tabs.filter((item) => !sameWorkTab(item, tab));
  }
  return tabs.length < MAX_PINNED_WORK_TABS ? [...tabs, tab] : tabs;
}

export function numericNavigationTarget(
  settings: Pick<ClientSettings, "numericNavigationMode" | "pinnedWorkTabs">,
  index: number,
  sidebarTarget: ScopedThreadRef | null,
): ScopedThreadRef | null {
  if (settings.numericNavigationMode === "sidebar") return sidebarTarget;
  return index >= 0 && index < MAX_PINNED_WORK_TABS
    ? (settings.pinnedWorkTabs[index] ?? null)
    : null;
}
