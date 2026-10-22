export function hasLocalShortcutOwner(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof Element &&
        node.matches(
          '[role="dialog"],[role="alertdialog"],[data-keyboard-local],.cm-editor,.monaco-editor',
        ),
    );
}

export function captureKeyboardFocus() {
  const element = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? {
          start: element.selectionStart,
          end: element.selectionEnd,
          direction: element.selectionDirection,
        }
      : null;
  const ranges = element?.isContentEditable
    ? Array.from({ length: window.getSelection()?.rangeCount ?? 0 }, (_, index) =>
        window.getSelection()!.getRangeAt(index).cloneRange(),
      )
    : [];
  const scroll: Array<{ element: HTMLElement; left: number; top: number }> = [];
  for (let parent = element; parent; parent = parent.parentElement)
    scroll.push({ element: parent, left: parent.scrollLeft, top: parent.scrollTop });
  return { element, selection, ranges, scroll, x: window.scrollX, y: window.scrollY };
}

export function restoreKeyboardFocus(snapshot: ReturnType<typeof captureKeyboardFocus>) {
  const { element, selection } = snapshot;
  if (!element?.isConnected) return;
  element.focus({ preventScroll: true });
  if (
    selection?.start !== null &&
    selection?.start !== undefined &&
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
  )
    element.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
  if (snapshot.ranges.length && element.isContentEditable) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    for (const range of snapshot.ranges)
      if (range.commonAncestorContainer.isConnected) selection?.addRange(range);
  }
  for (const position of snapshot.scroll)
    if (position.element.isConnected) position.element.scrollTo(position.left, position.top);
  window.scrollTo(snapshot.x, snapshot.y);
}
