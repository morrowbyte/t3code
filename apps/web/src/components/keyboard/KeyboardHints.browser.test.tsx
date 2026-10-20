import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { KeyboardHints } from "./KeyboardHints";
import { dispatchKeyboardCommand } from "./keyboardCommands";
import { userEvent } from "vite-plus/test/browser";

it("focuses the hinted visible control without activating it and restores focus on cancellation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const first = document.createElement("button");
  first.textContent = "First";
  const second = document.createElement("button");
  second.textContent = "Second";
  const hidden = document.createElement("button");
  hidden.hidden = true;
  hidden.textContent = "Hidden";
  const toast = document.createElement("div");
  const details = document.createElement("details");
  details.innerHTML = "<summary>Select lines</summary><button>Quote selected lines</button>";
  toast.setAttribute("role", "dialog");
  toast.setAttribute("aria-modal", "false");
  toast.textContent = "Non-modal notification";
  container.append(first, second, hidden, toast, details);
  document.body.append(container);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const activate = vi.fn();
  second.addEventListener("click", activate);
  try {
    await act(async () => root.render(<KeyboardHints />));
    first.focus();
    await act(async () => {
      expect(dispatchKeyboardCommand("navigation.hints")).toBe(true);
    });
    expect(document.querySelectorAll("[data-keyboard-hints] > span")).toHaveLength(3);
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(second));
    expect(activate).not.toHaveBeenCalled();
    await act(async () => {
      dispatchKeyboardCommand("navigation.hints");
    });
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(second));
    await act(async () => {
      dispatchKeyboardCommand("navigation.hints");
    });
    await act(async () => {
      await userEvent.keyboard("d");
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(details.querySelector("summary")));
    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    expect(details.open).toBe(true);
    await act(async () => {
      dispatchKeyboardCommand("navigation.hints");
    });
    expect(document.querySelectorAll("[data-keyboard-hints] > span")).toHaveLength(4);
    await act(async () => {
      first.focus();
    });
    expect(document.querySelector("[data-keyboard-hints]")).toBeNull();
    expect(document.activeElement).toBe(first);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    container.remove();
    vi.unstubAllGlobals();
  }
});
