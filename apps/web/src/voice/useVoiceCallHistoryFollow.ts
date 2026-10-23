import { useLayoutEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";

/** A footer's asynchronous height changes are outside LegendList's row anchoring. */
export function useVoiceCallHistoryFollow() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const history = ref.current;
    const scroll = history?.closest<HTMLElement>(".messages-timeline-scroll");
    if (!history || !scroll) return;
    const atEnd = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 24;
    let following = atEnd();
    const onScroll = () => {
      following = atEnd();
    };
    const stopObserving = observeResize(history, () => {
      if (following) scroll.scrollTop = scroll.scrollHeight;
    });
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stopObserving();
      scroll.removeEventListener("scroll", onScroll);
    };
  }, []);
  return ref;
}
