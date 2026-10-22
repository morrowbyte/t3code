import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import {
  discloseSidebar,
  focusSidebar,
  focusSidebarBoundary,
  moveSidebar,
  sidebarRows,
} from "./LeaderNavigation.dom";

it("uses one visible row per draft, saved thread and shelf in DOM order", async () => {
  await using screen = await render(
    <nav data-app-sidebar>
      <div data-keyboard-object="Thread" tabIndex={0} aria-current="page">
        Draft<button>Discard</button>
      </div>
      <div data-thread-item="saved">
        <div data-testid="sidebar-row-wrapper">
          <div data-testid="sidebar-row-card" data-keyboard-object="Thread" tabIndex={0}>
            Saved<button>Actions</button>
          </div>
        </div>
      </div>
      <button data-testid="sidebar-working-shelf-toggle">Working</button>
      <button data-testid="sidebar-settled-shelf-toggle">Settled</button>
      <button data-testid="sidebar-snoozed-shelf-toggle">Snoozed</button>
      <div hidden>
        <div data-keyboard-object="Thread" tabIndex={0}>
          Hidden
        </div>
      </div>
      <button data-keyboard-object="Thread" disabled>
        Disabled
      </button>
      <button data-keyboard-object="Thread" aria-disabled="true">
        Unavailable
      </button>
    </nav>,
  );
  const rows = sidebarRows();
  expect(rows.map((row) => row.textContent)).toEqual([
    "DraftDiscard",
    "SavedActions",
    "Working",
    "Settled",
    "Snoozed",
  ]);
  expect(focusSidebar()).toBe(true);
  expect(document.activeElement).toBe(rows[0]);
  expect(moveSidebar(1)).toBe(true);
  expect(document.activeElement).toBe(rows[1]);
  screen.container.querySelector<HTMLButtonElement>("button")!.focus();
  expect(moveSidebar(1)).toBe(true);
  expect(document.activeElement).toBe(rows[1]);
  expect(focusSidebarBoundary(true)).toBe(true);
  expect(document.activeElement).toBe(rows[4]);
  expect(moveSidebar(1)).toBe(true);
  expect(document.activeElement).toBe(rows[0]);
  expect(focusSidebarBoundary(false)).toBe(true);
  expect(document.activeElement).toBe(rows[0]);
});

function FamilyFixture() {
  const [expanded, setExpanded] = useState(false);
  return (
    <nav data-app-sidebar>
      <div data-sidebar-family-row="parent" data-family-depth={0}>
        <div data-thread-item="parent">
          <div data-testid="sidebar-row-card" data-keyboard-object="Thread" tabIndex={0}>
            Parent
            <button
              data-thread-family-disclosure
              data-thread-selection-safe
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              Agents
            </button>
            <button aria-haspopup="menu" aria-expanded="false">
              Actions
            </button>
          </div>
        </div>
      </div>
      {expanded && (
        <div data-sidebar-family-row="child" data-family-depth={1}>
          <div data-thread-item="child">
            <div data-testid="sidebar-row-card" data-keyboard-object="Thread" tabIndex={0}>
              Child
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

it("expands then enters a child, returns to its parent then collapses", async () => {
  await using screen = await render(<FamilyFixture />);
  focusSidebar();
  const parent = document.activeElement;
  await act(() => expect(discloseSidebar(true)).toBe(true));
  expect(sidebarRows()).toHaveLength(2);
  expect(document.activeElement).toBe(parent);
  expect(discloseSidebar(true)).toBe(true);
  expect(document.activeElement?.textContent).toBe("Child");
  expect(discloseSidebar(false)).toBe(true);
  expect(document.activeElement).toBe(parent);
  const menu = screen.container.querySelector<HTMLButtonElement>("[aria-haspopup]")!;
  menu.focus();
  expect(discloseSidebar(true)).toBe(false);
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  (parent as HTMLElement).focus();
  await act(() => expect(discloseSidebar(false)).toBe(true));
  expect(sidebarRows()).toHaveLength(1);
  expect(document.activeElement).toBe(parent);
});

it("preserves the legacy root-toggle fallback and ignores disabled disclosures", async () => {
  const disabledClick = vi.fn();
  await using screen = await render(
    <nav data-app-sidebar>
      <div data-thread-item="legacy">
        <div data-testid="sidebar-row-card" tabIndex={0}>
          Legacy
        </div>
        <button
          data-thread-selection-safe
          aria-expanded="false"
          onClick={(event) => event.currentTarget.setAttribute("aria-expanded", "true")}
        >
          Agents
        </button>
        <button aria-haspopup="menu" aria-expanded="false">
          Menu
        </button>
      </div>
      <div data-thread-item="disabled">
        <div data-testid="sidebar-row-card" tabIndex={0}>
          Disabled agents
        </div>
        <button
          data-thread-selection-safe
          aria-expanded="false"
          aria-disabled="true"
          onClick={disabledClick}
        >
          Agents
        </button>
      </div>
    </nav>,
  );
  focusSidebar();
  expect(discloseSidebar(true)).toBe(true);
  expect(
    screen.container.querySelector("[data-thread-selection-safe]")?.getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.container.querySelector("[aria-haspopup]")?.getAttribute("aria-expanded")).toBe(
    "false",
  );
  moveSidebar(1);
  expect(discloseSidebar(true)).toBe(false);
  expect(disabledClick).not.toHaveBeenCalled();
});
