import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
function snapshot() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
export function useVisualReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

function subscribeTextScale(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class"],
  });
  return () => observer.disconnect();
}

function textScaleSnapshot() {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) ? Math.max(1, size / 16) : 1;
}

export function useVisualTextScale() {
  return useSyncExternalStore(subscribeTextScale, textScaleSnapshot, () => 1);
}
