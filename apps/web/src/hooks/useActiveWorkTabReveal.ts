import { observeResize } from "../lib/observeResize";
import { useStableCallback } from "./useStableCallback";

export function useActiveWorkTabReveal() {
  return useStableCallback((container: HTMLElement | null) => {
    if (!container) return;
    let stopResize = () => {};
    const observeActive = () => {
      stopResize();
      const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      const active = container.querySelector<HTMLElement>("[data-active-work-tab]");
      if (!viewport || !active) return;
      const reveal = () => {
        const bounds = viewport.getBoundingClientRect();
        const item = active.getBoundingClientRect();
        const left = bounds.left + viewport.clientLeft;
        const right = left + viewport.clientWidth;
        const delta =
          item.left < left || item.width > viewport.clientWidth
            ? item.left - left
            : item.right > right
              ? item.right - right
              : 0;
        if (delta !== 0) viewport.scrollLeft += delta;
      };
      reveal();
      stopResize = observeResize(
        active.parentElement ? [viewport, active, active.parentElement] : [viewport, active],
        reveal,
      );
    };
    const mutations = new MutationObserver(observeActive);
    mutations.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-active-work-tab"],
    });
    observeActive();
    return () => {
      mutations.disconnect();
      stopResize();
    };
  });
}
