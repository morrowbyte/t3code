import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LeaderNavigation } from "./LeaderNavigation";
import { requestLeaderNavigation } from "./LeaderNavigation.dom";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { shouldTypeToFocusComposer } from "../chat/composerFocusRedirect";
import { dismissContextMenu, showContextMenuFallback } from "../../contextMenuFallback";

let root: Root;
let host: HTMLDivElement;
let fixture: HTMLDivElement;
const action = vi.fn(async () => {});
const redirected = vi.fn();
function TypeToFocusProbe() {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!shouldTypeToFocusComposer(event)) return;
      redirected(event.key);
      event.preventDefault();
      fixture.querySelector("textarea")?.focus();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return null;
}
const groups = [
  { key: "t", label: "Threads", actions: [{ key: "n", label: "Next thread", run: action }] },
  { key: "s", label: "Sidebar", actions: [] },
];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([]);
  action.mockClear();
  redirected.mockClear();
  fixture = document.createElement("div");
  fixture.innerHTML =
    '<main><div data-chat-composer-main-surface="true"><textarea aria-label="Test composer"></textarea></div>' +
    '<div data-message-id="one" data-message-role="user">First message<button>Copy first</button></div>' +
    '<div data-message-id="two" data-message-role="assistant">Second message<button>Copy second</button><button>Details</button></div>' +
    '<nav aria-label="Threads" data-app-sidebar><button aria-haspopup="dialog" aria-expanded="false">Project filter</button><div data-thread-item="one"><div data-testid="sidebar-row-card" role="button" tabindex="0">First thread</div></div>' +
    '<div data-thread-item="two"><div data-testid="sidebar-row-card" role="button" tabindex="0">Second thread</div><button aria-haspopup="menu" aria-expanded="false">Snooze</button><button data-thread-selection-safe aria-expanded="false">Expand agents</button></div>' +
    '<button data-testid="sidebar-settled-shelf-toggle" aria-expanded="false">Settled</button></nav></main>';
  document.body.append(fixture);
  const fold = fixture.querySelector<HTMLButtonElement>("button[data-thread-selection-safe]")!;
  fold.addEventListener("click", () =>
    fold.setAttribute(
      "aria-expanded",
      fold.getAttribute("aria-expanded") === "true" ? "false" : "true",
    ),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() =>
    root.render(
      <>
        <TypeToFocusProbe />
        <LeaderNavigation groups={groups} isClaimed={() => false} showSidebar={() => {}} />
      </>,
    ),
  );
});
afterEach(async () => {
  dismissContextMenu();
  await act(() => root.unmount());
  host.remove();
  fixture.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function flush() {
  await act(() => vi.advanceTimersByTimeAsync(300));
  await act(() => vi.advanceTimersToNextFrame());
}
async function press(key: string, values: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...values });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await flush();
  return event;
}
async function open() {
  await act(() => {
    requestLeaderNavigation();
  });
  await flush();
}

describe("LeaderNavigation", () => {
  it("discovers messages loaded after the navigation host mounted", async () => {
    const messages = [...fixture.querySelectorAll("[data-message-id]")];
    messages.forEach((message) => message.remove());
    await act(() => root.unmount());
    root = createRoot(host);
    await act(() =>
      root.render(
        <LeaderNavigation groups={groups} isClaimed={() => false} showSidebar={() => {}} />,
      ),
    );
    await open();
    expect(document.querySelector<HTMLButtonElement>('[data-leader-key="m"]')?.disabled).toBe(true);
    await press("Escape");
    messages.forEach((message) => fixture.append(message));
    await open();
    expect(document.querySelector<HTMLButtonElement>('[data-leader-key="m"]')?.disabled).toBe(
      false,
    );
    await press("m");
    expect(document.activeElement?.getAttribute("data-message-id")).toBe("two");
  });

  it("preserves composer Space, j/k and IME while explicit entry returns focus on Escape", async () => {
    const composer = fixture.querySelector("textarea")!;
    composer.focus();
    expect((await press(" ")).defaultPrevented).toBe(false);
    expect((await press("j")).defaultPrevented).toBe(false);
    expect((await press(" ", { isComposing: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[aria-label="Keyboard navigation"]')).toBeNull();
    await open();
    expect(
      document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]'),
    ).not.toBeNull();
    await press("Escape");
    expect(document.activeElement).toBe(composer);
  });

  it("opens with Space on non-controls, discovers groups and executes one selected action", async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    expect((await press(" ")).defaultPrevented).toBe(true);
    await press("t");
    expect(document.activeElement?.textContent).toContain("Next thread");
    await press("n");
    expect(action).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]')).toBeNull();
  });

  it("navigates messages and their own controls only after opt-in, then restores composer", async () => {
    const composer = fixture.querySelector("textarea")!;
    composer.focus();
    await open();
    await press("m");
    expect(document.activeElement?.getAttribute("data-message-id")).toBe("two");
    await press("k");
    expect(document.activeElement?.getAttribute("data-message-id")).toBe("one");
    expect(redirected).not.toHaveBeenCalled();
    await press("j");
    await press("l");
    expect(document.activeElement?.textContent).toBe("Copy second");
    await press("l");
    expect(document.activeElement?.textContent).toBe("Details");
    await press("h");
    expect(document.activeElement?.textContent).toBe("Copy second");
    await press("Escape");
    expect(document.activeElement).toBe(composer);
    expect(document.querySelector("[data-leader-message-focus]")).toBeNull();
    expect(fixture.querySelector('[data-message-id="one"]')?.hasAttribute("tabindex")).toBe(false);
    composer.blur();
    await press(" ");
    await press("m");
    await press("l");
    await press("Escape");
    expect(document.activeElement).toBe(composer);
  });

  it("navigates sidebar rows and shelves while h/l preserve root-only disclosure", async () => {
    const drawer = document.createElement("div");
    drawer.setAttribute("role", "dialog");
    const navigation = fixture.querySelector("nav")!;
    navigation.before(drawer);
    drawer.append(navigation);
    await open();
    await press("s");
    await press("f");
    expect(document.activeElement?.textContent).toBe("First thread");
    await press("j");
    expect(document.activeElement?.textContent).toBe("Second thread");
    await press("l");
    expect(
      fixture.querySelector("button[data-thread-selection-safe]")?.getAttribute("aria-expanded"),
    ).toBe("true");
    await press("h");
    expect(
      fixture.querySelector("button[data-thread-selection-safe]")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(fixture.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    await press("j");
    expect(document.activeElement?.textContent).toBe("Settled");
    await press("Escape");
  });

  it("keeps the composer return target across a palette exit while the chat is inert", async () => {
    const composer = fixture.querySelector("textarea")!;
    composer.focus();
    const palette = document.createElement("div");
    palette.setAttribute("data-command-palette", "true");
    const input = document.createElement("input");
    palette.append(input);
    document.body.append(palette);
    input.focus();
    const main = fixture.querySelector("main")!;
    main.inert = true;
    await act(() => {
      requestLeaderNavigation();
    });
    await act(() => palette.remove());
    await flush();
    expect(
      document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]'),
    ).not.toBeNull();
    main.inert = false;
    await press("m");
    expect(document.activeElement?.getAttribute("data-message-id")).toBe("two");
    composer.style.display = "none";
    const expand = document.createElement("button");
    expand.setAttribute("aria-label", "Expand composer");
    expand.addEventListener("click", () => {
      composer.style.display = "";
      composer.focus();
      expand.remove();
    });
    main.append(expand);
    await press("Escape");
    expect(document.activeElement).toBe(composer);
    expect(expand.isConnected).toBe(false);
  });

  it("uses Ctrl N/P in the overlay and an actual menu, without claiming browser Ctrl P outside", async () => {
    expect((await press("p", { ctrlKey: true })).defaultPrevented).toBe(false);
    await open();
    await press("n", { ctrlKey: true });
    expect(document.activeElement?.textContent).toContain("Sidebar");
    await press("ArrowUp");
    expect(document.activeElement?.textContent).toContain("Threads");
    await press("Escape");
    await act(() =>
      root.render(
        <>
          <LeaderNavigation groups={groups} isClaimed={() => false} showSidebar={() => {}} />
          <Menu defaultOpen>
            <MenuTrigger>Actions</MenuTrigger>
            <MenuPopup>
              <MenuItem>First</MenuItem>
              <MenuItem disabled>Disabled</MenuItem>
              <MenuItem>Last</MenuItem>
            </MenuPopup>
          </Menu>
        </>,
      ),
    );
    await flush();
    const first = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    first.focus();
    expect((await press("n", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe("Last");
    await press("p", { ctrlKey: true });
    expect(document.activeElement?.textContent).toBe("First");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Last");
    await press("Escape");
    void showContextMenuFallback([
      { id: "first", label: "First context action" },
      { id: "disabled", label: "Disabled context action", disabled: true },
      { id: "last", label: "Last context action" },
    ]);
    await flush();
    expect((await press("n", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe("First context action");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Last context action");
    await press("p", { ctrlKey: true });
    expect(document.activeElement?.textContent).toBe("First context action");
    await press("Escape");
  });
});
