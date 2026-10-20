export const NAVIGATION_MODE_EVENT = "t3code:navigation-mode";

export function isNavigationMode(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.keyboardMode === "navigation"
  );
}

export function requestNavigationMode(): void {
  document.documentElement.dataset.keyboardMode = "navigation";
  window.dispatchEvent(new Event(NAVIGATION_MODE_EVENT));
}

export function leaveNavigationMode(): void {
  delete document.documentElement.dataset.keyboardMode;
  window.dispatchEvent(new Event(NAVIGATION_MODE_EVENT));
}
