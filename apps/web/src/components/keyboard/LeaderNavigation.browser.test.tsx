import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { LeaderNavigation } from "./LeaderNavigation";
import { LeaderNavigationHost } from "./LeaderNavigationHost";
import { SidebarProvider } from "../ui/sidebar";
import { requestLeaderNavigation } from "./LeaderNavigation.dom";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { shouldTypeToFocusComposer } from "../chat/composerFocusRedirect";
import { dismissContextMenu, showContextMenuFallback } from "../../contextMenuFallback";
import { isNavigationMode, leaveNavigationMode, requestNavigationMode } from "./navigationMode";
import { useKeyboardCommands } from "./keyboardCommands";
import { WorkbenchCommandPicker } from "./WorkbenchCommandPicker";

function TypeToFocusProbe({
  fixture,
  redirected,
}: {
  fixture: HTMLElement;
  redirected: (key: string) => void;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!shouldTypeToFocusComposer(event)) return;
      redirected(event.key);
      event.preventDefault();
      fixture.querySelector("textarea")?.focus();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [fixture, redirected]);
  return null;
}

function setup() {
  using resources = new DisposableStack();
  leaveNavigationMode();
  resources.defer(() => {
    leaveNavigationMode();
    dismissContextMenu();
  });
  resources.use(vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([]));
  const action = vi.fn(async () => {});
  const redirected = vi.fn();
  const groups = [
    { key: "t", label: "Threads", actions: [{ key: "n", label: "Next thread", run: action }] },
    { key: "s", label: "Sidebar", actions: [] },
  ];
  const fixture = document.createElement("div");
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
  resources.defer(() => fixture.remove());
  const navigation = (
    <>
      <TypeToFocusProbe fixture={fixture} redirected={redirected} />
      <LeaderNavigation groups={groups} isClaimed={() => false} showSidebar={() => {}} />
    </>
  );
  const cleanup = resources.move();
  return {
    fixture,
    action,
    redirected,
    groups,
    navigation,
    [Symbol.dispose]: () => cleanup.dispose(),
  };
}
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
  it("keeps a keyboard-selected context action visible in a long picker", async () => {
    using _context = setup();
    await using _screen = await render(
      <WorkbenchCommandPicker
        title="Context controls"
        onClose={() => {}}
        commands={Array.from({ length: 18 }, (_, index) => ({
          id: String(index),
          label: `Action ${index + 1}`,
          run: () => {},
        }))}
      />,
    );
    using _timers = fakeTimers();
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    list.style.height = "80px";
    list.style.overflow = "auto";
    for (const option of list.querySelectorAll<HTMLElement>('[role="option"]')) {
      option.style.display = "block";
      option.style.height = "30px";
    }
    document.querySelector<HTMLInputElement>('[role="combobox"]')!.focus();
    for (let index = 0; index < 12; index++) await press("ArrowDown");
    const selected = list.querySelector<HTMLElement>('[aria-selected="true"]')!;
    expect(selected.textContent).toContain("Action 13");
    expect(selected.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      list.getBoundingClientRect().top,
    );
    expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      list.getBoundingClientRect().bottom,
    );
    expect(list.scrollTop).toBeGreaterThan(0);
  });
  it("cycles regions with F6 while a non-modal update notification is visible", async () => {
    using context = setup();
    const { fixture, navigation } = context;
    await using _screen = await render(navigation);
    using _timers = fakeTimers();
    const notification = document.createElement("div");
    notification.setAttribute("role", "dialog");
    notification.setAttribute("aria-modal", "false");
    notification.innerHTML = "Update available<button>Update now</button>";
    fixture.append(notification);
    const composer = fixture.querySelector("textarea")!;
    composer.focus();
    expect((await press("F6")).defaultPrevented).toBe(true);
    expect(fixture.querySelector("nav")!.contains(document.activeElement)).toBe(true);
    expect((await press("F6", { shiftKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(composer);
    notification.removeAttribute("aria-modal");
    notification.setAttribute("data-slot", "dialog-popup");
    expect((await press("F6")).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(composer);
  });
  it("keeps navigation active after leaving the composer until i explicitly returns", async () => {
    using context = setup();
    const { fixture, redirected, navigation } = context;
    await using _screen = await render(navigation);
    using _timers = fakeTimers();
    const composer = fixture.querySelector("textarea")!;
    composer.focus();
    composer.blur();
    await act(() => requestNavigationMode());
    await press("x");
    expect(redirected).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(composer);
    await press(" ");
    await press("Escape");
    expect(isNavigationMode()).toBe(true);
    await press("i");
    expect(document.activeElement).toBe(composer);
    expect(isNavigationMode()).toBe(false);
  });

  it("runs composer commands through the leader without typing into the draft", async () => {
    using context = setup();
    const { fixture } = context;
    const model = vi.fn();
    function Commands() {
      useKeyboardCommands({ "modelPicker.toggle": model });
      return (
        <SidebarProvider>
          <LeaderNavigationHost />
        </SidebarProvider>
      );
    }
    await using _screen = await render(<Commands />);
    using _timers = fakeTimers();
    await act(() => requestNavigationMode());
    await press(" ");
    await press("c");
    await press("m");
    expect(model).toHaveBeenCalledOnce();
    expect(fixture.querySelector("textarea")!.value).toBe("");
  });

  it("returns from a desktop browser through the forwarded navigation command", async () => {
    using _context = setup();
    let menuAction: ((action: string) => void) | undefined;
    using _bridge = stubGlobal("desktopBridge", {
      onMenuAction: (listener: (action: string) => void) => {
        menuAction = listener;
        return () => {};
      },
    });
    await using _screen = await render(
      <SidebarProvider>
        <LeaderNavigationHost />
      </SidebarProvider>,
    );
    using _timers = fakeTimers();
    await act(() => menuAction?.("navigation.activate"));
    await flush();
    expect(isNavigationMode()).toBe(true);
    expect(document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]')).toBeNull();
    await press(" ");
    expect(
      document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]'),
    ).not.toBeNull();
    expect(isNavigationMode()).toBe(true);
  });

  it("uses the configured app prefix from an editable without consuming ordinary terminal keys", async () => {
    using context = setup();
    const { fixture, groups } = context;
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    terminal.tabIndex = 0;
    fixture.append(terminal);
    await using _screen = await render(
      <LeaderNavigation
        groups={groups}
        showSidebar={() => {}}
        isClaimed={() => false}
        isActivationShortcut={(event) => event.ctrlKey && event.key === "g"}
      />,
    );
    using _timers = fakeTimers();
    terminal.focus();
    expect((await press(" ")).defaultPrevented).toBe(false);
    expect((await press("g", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(isNavigationMode()).toBe(true);
    expect(document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]')).toBeNull();
    expect((await press(" ")).defaultPrevented).toBe(true);
    expect(
      document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]'),
    ).not.toBeNull();
  });

  it("opens the existing project filter after a project has already been selected", async () => {
    using context = setup();
    const { fixture } = context;
    const filter = fixture.querySelector<HTMLButtonElement>("nav > button")!;
    filter.setAttribute("aria-label", "Filter threads by project: Example project");
    filter.setAttribute("popovertarget", "selected-project-filter");
    const popup = document.createElement("div");
    popup.id = "selected-project-filter";
    popup.setAttribute("popover", "auto");
    popup.textContent = "Switch project";
    fixture.append(popup);
    await using _screen = await render(
      <SidebarProvider>
        <LeaderNavigationHost />
      </SidebarProvider>,
    );
    using _timers = fakeTimers();
    await open();
    await press("p");
    await press("f");
    expect(popup.matches(":popover-open")).toBe(true);
  });

  it("skips disabled message navigation in both directions with arrows and Ctrl N/P", async () => {
    using context = setup();
    const { fixture } = context;
    fixture.querySelectorAll("[data-message-id]").forEach((message) => message.remove());
    await using _screen = await render(
      <SidebarProvider>
        <LeaderNavigationHost />
      </SidebarProvider>,
    );
    using _timers = fakeTimers();
    await open();
    expect(document.querySelector<HTMLButtonElement>('[data-leader-key="m"]')?.disabled).toBe(true);
    for (const [key, ctrlKey, from, expected] of [
      ["ArrowDown", false, "t", ["p", "s", "a", "i"]],
      ["n", true, "t", ["p", "s", "a", "i"]],
      ["ArrowUp", false, "i", ["a", "s", "p", "t"]],
      ["p", true, "i", ["a", "s", "p", "t"]],
    ] as const) {
      document.querySelector<HTMLButtonElement>(`[data-leader-key="${from}"]`)!.focus();
      const visited: Array<string | null> = [];
      for (const _entry of expected) {
        await press(key, { ctrlKey });
        visited.push(document.activeElement?.getAttribute("data-leader-key") ?? null);
      }
      expect.soft(visited).toEqual(expected);
    }
    await press("i");
    expect(document.activeElement).toBe(fixture.querySelector("textarea"));
  });

  it("discovers messages loaded after the navigation host mounted", async () => {
    using context = setup();
    const { fixture, groups } = context;
    const messages = [...fixture.querySelectorAll("[data-message-id]")];
    messages.forEach((message) => message.remove());
    await using _screen = await render(
      <LeaderNavigation groups={groups} isClaimed={() => false} showSidebar={() => {}} />,
    );
    using _timers = fakeTimers();
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

  it("preserves composer Space, j/k and IME while Escape returns to navigation", async () => {
    using context = setup();
    const { fixture, navigation } = context;
    await using _screen = await render(navigation);
    using _timers = fakeTimers();
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
    expect(isNavigationMode()).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("App navigation");
    await press("i");
    expect(document.activeElement).toBe(composer);
  });

  it("opens with Space on non-controls, discovers groups and executes one selected action", async () => {
    using context = setup();
    const { action, navigation } = context;
    await using _screen = await render(navigation);
    using _timers = fakeTimers();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    expect((await press(" ")).defaultPrevented).toBe(true);
    await press("t");
    expect(document.activeElement?.textContent).toContain("Next thread");
    await press("n");
    expect(action).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]')).toBeNull();
  });

  it.each([false, true])(
    "executes a rapid thread sequence with an already mounted menu: %s",
    async (mounted) => {
      using context = setup();
      const { action, navigation } = context;
      await using _screen = await render(navigation);
      using _timers = fakeTimers();
      await act(() => requestNavigationMode());
      if (mounted) await open();
      const events = (mounted ? ["t", "n"] : [" ", "t", "n"]).map(
        (key) => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
      await act(() => {
        for (const event of events) (document.activeElement ?? document.body).dispatchEvent(event);
      });
      await flush();
      expect(events.every((event) => event.defaultPrevented)).toBe(true);
      expect(action).toHaveBeenCalledOnce();
      expect(
        document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]'),
      ).toBeNull();
      await flush();
      expect(action).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { group: "f", key: "a", command: "composer.attachFiles", mounted: false },
    { group: "f", key: "a", command: "composer.attachFiles", mounted: true },
    { group: "w", key: "s", command: "project.scripts", mounted: false },
    { group: "w", key: "s", command: "project.scripts", mounted: true },
  ] as const)(
    "executes rapid $group,$key once with an already mounted menu: $mounted",
    async ({ group, key, command, mounted }) => {
      using _context = setup();
      const run = vi.fn();
      function Commands() {
        useKeyboardCommands({ [command]: run });
        return (
          <SidebarProvider>
            <LeaderNavigationHost />
          </SidebarProvider>
        );
      }
      await using _screen = await render(<Commands />);
      using _timers = fakeTimers();
      await act(() => requestNavigationMode());
      if (mounted) await open();
      const events = (mounted ? [group, key] : [" ", group, key]).map(
        (key) => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
      await act(() => {
        for (const event of events) (document.activeElement ?? document.body).dispatchEvent(event);
      });
      await flush();
      expect(events.every((event) => event.defaultPrevented)).toBe(true);
      expect(run).toHaveBeenCalledOnce();
      expect(
        document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]'),
      ).toBeNull();
      await flush();
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("backs out one leader group at a time while keeping navigation active", async () => {
    using context = setup();
    const { navigation } = context;
    await using _screen = await render(navigation);
    using _timers = fakeTimers();
    await open();
    await press("t");
    expect(document.activeElement?.textContent).toContain("Next thread");
    await press("Escape");
    expect(document.querySelector('[data-leader-key="t"]')).not.toBeNull();
    expect(
      document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]'),
    ).not.toBeNull();
    await press("Escape");
    expect(document.querySelector('[role="dialog"][aria-label="Keyboard navigation"]')).toBeNull();
    expect(isNavigationMode()).toBe(true);
  });

  it("navigates messages and controls then returns through navigation to the composer", async () => {
    using context = setup();
    const { fixture, redirected, navigation } = context;
    await using _screen = await render(navigation);
    using _timers = fakeTimers();
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
    expect(document.activeElement?.getAttribute("aria-label")).toBe("App navigation");
    expect(document.querySelector("[data-leader-message-focus]")).toBeNull();
    expect(fixture.querySelector('[data-message-id="one"]')?.hasAttribute("tabindex")).toBe(false);
    composer.blur();
    await press(" ");
    await press("m");
    await press("l");
    await press("Escape");
    await press("i");
    expect(document.activeElement).toBe(composer);
  });

  it("navigates sidebar rows and shelves while h/l preserve root-only disclosure", async () => {
    using context = setup();
    const { fixture, navigation } = context;
    await using _screen = await render(navigation);
    using _timers = fakeTimers();
    const drawer = document.createElement("div");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("data-mobile", "true");
    drawer.setAttribute("data-sidebar", "sidebar");
    const sidebar = fixture.querySelector("nav")!;
    sidebar.before(drawer);
    drawer.append(sidebar);
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
    using context = setup();
    const { fixture, navigation } = context;
    await using _screen = await render(navigation);
    using _timers = fakeTimers();
    const composer = fixture.querySelector("textarea")!;
    composer.focus();
    const palette = document.createElement("div");
    palette.setAttribute("data-command-palette", "true");
    const input = document.createElement("input");
    palette.append(input);
    fixture.append(palette);
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
    expect(document.activeElement?.getAttribute("aria-label")).toBe("App navigation");
    await press("i");
    expect(document.activeElement).toBe(composer);
    expect(expand.isConnected).toBe(false);
  });

  it("uses Ctrl N/P in the overlay and an actual menu, without claiming browser Ctrl P outside", async () => {
    using context = setup();
    const { groups, navigation } = context;
    await using screen = await render(navigation);
    using _timers = fakeTimers();
    expect((await press("p", { ctrlKey: true })).defaultPrevented).toBe(false);
    await open();
    await press("n", { ctrlKey: true });
    expect(document.activeElement?.textContent).toContain("Sidebar");
    await press("ArrowUp");
    expect(document.activeElement?.textContent).toContain("Threads");
    await press("Escape");
    await screen.rerender(
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
    expect(document.activeElement?.textContent).toBe("First context action");
    expect((await press("n", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe("Last context action");
    expect((await press("p", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe("First context action");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Last context action");
    await press("p", { ctrlKey: true });
    expect(document.activeElement?.textContent).toBe("First context action");
    await press("Escape");
  });
});
