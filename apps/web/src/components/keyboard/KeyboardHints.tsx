import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useKeyboardCommands } from "./keyboardCommands";

const alphabet = "asdfghjklqwertyuiopzxcvbnm";
const selector =
  'button,a[href],input:not([type="hidden"]),textarea,select,[role="button"],[role="combobox"],[role="tab"],[contenteditable="true"],[tabindex="0"]';

export function keyboardHintTargets(root: ParentNode = document) {
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
    .filter((element) => {
      if (element.closest('[inert],[aria-hidden="true"],[data-keyboard-hints]')) return false;
      if (element.matches(':disabled,[aria-disabled="true"]')) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 2 &&
        box.height > 2 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < window.innerHeight &&
        box.left < window.innerWidth &&
        style.visibility === "visible" &&
        style.display !== "none"
      );
    })
    .slice(0, alphabet.length ** 2);
}

export function KeyboardHints() {
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  const [prefix, setPrefix] = useState("");
  const layer = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const close = (target = origin.current) => {
    setTargets([]);
    setPrefix("");
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  };
  useKeyboardCommands({
    "navigation.hints": () => {
      const dialog = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"]:not([aria-modal="false"]),[role="alertdialog"]:not([aria-modal="false"])',
        ),
      ).findLast(
        (element) =>
          !element.closest('[inert],[aria-hidden="true"]') &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility === "visible",
      );
      origin.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setTargets(keyboardHintTargets(dialog ?? document));
      setPrefix("");
    },
  });
  useLayoutEffect(() => {
    if (targets.length) layer.current?.focus({ preventScroll: true });
  }, [targets]);
  if (!targets.length) return null;
  const labels = targets.map((_, index) =>
    targets.length <= alphabet.length
      ? alphabet[index]!
      : alphabet[Math.floor(index / alphabet.length)]! + alphabet[index % alphabet.length]!,
  );
  return createPortal(
    <div
      ref={layer}
      role="dialog"
      aria-modal="true"
      aria-label="Focus a control by its hint"
      data-keyboard-hints
      tabIndex={-1}
      className="fixed inset-0 z-[100] outline-none"
      onPointerDown={() => close()}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") return close();
        if (event.key === "Backspace") return setPrefix(prefix.slice(0, -1));
        if (event.key.length !== 1 || event.repeat) return;
        const next = prefix + event.key.toLowerCase();
        const index = labels.indexOf(next);
        if (index >= 0) close(targets[index]);
        else setPrefix(labels.some((label) => label.startsWith(next)) ? next : "");
      }}
    >
      {targets.map((target, index) => {
        const label = labels[index]!;
        if (!label.startsWith(prefix)) return null;
        const box = target.getBoundingClientRect();
        return (
          <span
            key={label}
            className="pointer-events-none fixed rounded border border-ring bg-popover px-1 font-mono text-xs font-bold text-popover-foreground shadow"
            style={{
              left: Math.max(2, Math.min(window.innerWidth - 30, box.left)),
              top: Math.max(2, box.top),
            }}
          >
            {label}
          </span>
        );
      })}
      <div
        role="status"
        className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow"
      >
        Focus control · {prefix || "Type a hint"} · Esc
      </div>
    </div>,
    document.body,
  );
}
