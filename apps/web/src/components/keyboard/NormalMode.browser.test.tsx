import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import "~/index.css";
import { LeaderNavigation } from "./LeaderNavigation";
import { LeaderNavigationHost } from "./LeaderNavigationHost";
import { SidebarProvider } from "../ui/sidebar";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "../ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isNavigationMode, leaveNavigationMode, requestNavigationMode } from "./navigationMode";
import { dispatchKeyboardCommand } from "./keyboardCommands";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";

function setup(): Disposable {
  leaveNavigationMode();
  return { [Symbol.dispose]: leaveNavigationMode };
}

function Navigation() {
  return (
    <LeaderNavigation
      groups={[{ key: "s", label: "Sidebar", actions: [] }]}
      isClaimed={() => false}
      isActivationShortcut={(event) =>
        event.key === " " && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
      }
      showSidebar={() => {}}
    />
  );
}

function ProjectFilter() {
  const [selected, setSelected] = useState("All projects");
  const projects = ["All projects", "Example project"];
  return (
    <Combobox
      items={projects}
      value={selected}
      onValueChange={(value) => value && setSelected(value)}
    >
      <ComboboxTrigger aria-label={`Filter threads by project: ${selected}`}>
        Projects
      </ComboboxTrigger>
      <ComboboxPopup>
        <ComboboxSearchInput aria-label="Search projects" />
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

it("recovers Space after a mouse-opened project filter closes back onto its trigger", async () => {
  using _mode = setup();
  await using screen = await render(
    <>
      <ProjectFilter />
      <Navigation />
    </>,
  );
  await screen.getByRole("combobox", { name: "Filter threads by project: All projects" }).click();
  await expect.element(page.getByRole("combobox", { name: "Search projects" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toContain(
      "Filter threads by project",
    ),
  );
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(isNavigationMode()).toBe(true));
  await userEvent.keyboard(" ");
  await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
  expect(document.querySelector('[aria-label="Search projects"]')).toBeNull();
});

it("leaves an ordinary input without changing its value and keeps Space for Which-Key", async () => {
  using _mode = setup();
  await using screen = await render(
    <>
      <input aria-label="Search threads" defaultValue="keep this query" />
      <Navigation />
    </>,
  );
  await screen.getByRole("textbox", { name: "Search threads" }).click();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(isNavigationMode()).toBe(true));
  expect(screen.container.querySelector("input")!.value).toBe("keep this query");
  await userEvent.keyboard(" ");
  await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
});

it("enters Normal mode when a focused app button's tooltip consumes Escape", async () => {
  using _mode = setup();
  await using _screen = await render(
    <>
      <Tooltip>
        <TooltipTrigger aria-label="Project filter">Projects</TooltipTrigger>
        <TooltipPopup>Filter threads by project</TooltipPopup>
      </Tooltip>
      <Navigation />
    </>,
  );
  await userEvent.tab();
  await expect.element(page.getByText("Filter threads by project", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(isNavigationMode()).toBe(true));
  await userEvent.keyboard(" ");
  await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
});

function SettingsFixture({ onExit }: { onExit: () => void }) {
  useEscapeToGoBack(onExit);
  return (
    <main data-keyboard-region="settings" aria-label="Settings">
      <div data-keyboard-object="Setting" tabIndex={-1} aria-label="First setting">
        <input aria-label="Edit first setting" defaultValue="unchanged" />
      </div>
      <div data-keyboard-object="Setting" tabIndex={-1} aria-label="Second setting">
        <button data-keyboard-primary>Change second setting</button>
      </div>
    </main>
  );
}

it("enters Normal mode within Settings without exiting and navigates the settings rows", async () => {
  using _mode = setup();
  const exit = vi.fn();
  await using screen = await render(
    <>
      <SettingsFixture onExit={exit} />
      <Navigation />
    </>,
  );
  await screen.getByRole("textbox").click();
  await userEvent.keyboard("{Control>}{Shift>} {/Shift}{/Control}");
  expect(isNavigationMode()).toBe(true);
  expect(exit).not.toHaveBeenCalled();
  await userEvent.keyboard("j");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Second setting");
  await userEvent.keyboard("k");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("First setting");
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
});

it("gives a local cancellation handler first refusal before entering Normal mode", async () => {
  using _mode = setup();
  let pending = true;
  await using screen = await render(
    <>
      <input
        aria-label="Rename"
        onKeyDown={(event) => {
          if (event.key === "Escape" && pending) {
            pending = false;
            event.preventDefault();
          }
        }}
      />
      <Navigation />
    </>,
  );
  await screen.getByRole("textbox").click();
  await userEvent.keyboard("{Escape}");
  expect(isNavigationMode()).toBe(false);
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(isNavigationMode()).toBe(true));
});

it("uses the app prefix before terminal input while leaving plain Escape to the terminal", async () => {
  using _mode = setup();
  const terminal = vi.fn();
  await using screen = await render(
    <>
      <section data-keyboard-region="Terminal" data-terminal-owner="drawer">
        <div data-keyboard-object="Terminal output">
          <textarea
            aria-label="Terminal input"
            data-keyboard-local
            onKeyDown={(event) => {
              terminal(event);
              event.preventDefault();
              event.stopPropagation();
            }}
          />
        </div>
      </section>
      <Navigation />
    </>,
  );
  await screen.getByRole("textbox").click();
  await userEvent.keyboard("{Escape}");
  expect(terminal).toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.container.querySelector("textarea"));
  terminal.mockClear();
  await userEvent.keyboard("{Control>}{Shift>} {/Shift}{/Control}");
  expect(terminal.mock.calls.some(([event]) => event.key === " ")).toBe(false);
  expect(isNavigationMode()).toBe(true);
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("App navigation"),
  );
  await userEvent.keyboard(" ");
  await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
});

it("uses the forwarded browser app command to release page focus without opening Which-Key", async () => {
  using _mode = setup();
  await using screen = await render(
    <>
      <div data-right-panel-surface-content>
        <div data-keyboard-object="Browser" data-preview-panel-mode="desktop">
          <input aria-label="Web page input" />
        </div>
      </div>
      <Navigation />
    </>,
  );
  await screen.getByRole("textbox").click();
  await act(() => {
    dispatchKeyboardCommand("navigation.activate");
  });
  expect(isNavigationMode()).toBe(true);
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("App navigation"),
  );
  expect(document.querySelector('[aria-label="Keyboard navigation"]')).toBeNull();
  await userEvent.keyboard(" ");
  await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
});

it("uses the same sidebar rows after mouse focus and after Which-Key, then releases stale sidebar mode", async () => {
  using _mode = setup();
  await using screen = await render(
    <>
      <nav data-app-sidebar aria-label="Threads">
        <button>Filter</button>
        <div data-keyboard-object="Thread" tabIndex={0}>
          Draft
        </div>
        <button data-testid="sidebar-working-shelf-toggle">Working</button>
        <button data-testid="sidebar-settled-shelf-toggle">Settled</button>
      </nav>
      <main data-keyboard-region="Conversation">
        <article data-keyboard-object="Message" tabIndex={0}>
          First message
        </article>
        <article data-keyboard-object="Message" tabIndex={0}>
          Second message
        </article>
      </main>
      <Navigation />
    </>,
  );
  await screen.getByRole("button", { name: "Filter", exact: true }).click();
  await userEvent.keyboard("{Control>}{Shift>} {/Shift}{/Control}");
  await userEvent.keyboard("j");
  expect(document.activeElement?.textContent).toBe("Draft");
  await userEvent.keyboard("j");
  expect(document.activeElement?.textContent).toBe("Working");
  await userEvent.keyboard("{End}");
  expect(document.activeElement?.textContent).toBe("Settled");
  await userEvent.keyboard("{Home}");
  expect(document.activeElement?.textContent).toBe("Draft");
  await userEvent.keyboard(" sf");
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Draft"));
  await screen.getByText("First message", { exact: true }).click();
  await userEvent.keyboard("j");
  expect(document.activeElement?.textContent).toBe("Second message");
});

it("keeps modified, repeated and composing Escape out of the app fallback", async () => {
  using _mode = setup();
  await using screen = await render(
    <>
      <input aria-label="Input" />
      <Navigation />
    </>,
  );
  const input = screen.container.querySelector("input")!;
  await screen.getByRole("textbox").click();
  for (const options of [
    { ctrlKey: true },
    { shiftKey: true },
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
  ]) {
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
          ...options,
        }),
      ),
    );
  }
  expect(isNavigationMode()).toBe(false);
  expect(document.activeElement).toBe(input);
});

it.each(["terminal", "browser"])(
  "keeps Which-Key reachable when Normal-mode region cycling enters %s controls",
  async (surface) => {
    using _mode = setup();
    await using screen = await render(
      <SidebarProvider>
        <nav data-app-sidebar>
          <button>Threads</button>
        </nav>
        <section
          data-keyboard-region={surface}
          data-terminal-owner={surface === "terminal" ? "drawer" : undefined}
          data-preview-panel-mode={surface === "browser" ? "inline" : undefined}
        >
          <div data-keyboard-object="Surface controls" tabIndex={-1}>
            <button>Local action</button>
          </div>
        </section>
        <div data-chat-composer-main-surface>
          <textarea aria-label="Draft" />
        </div>
        <LeaderNavigationHost />
      </SidebarProvider>,
    );
    await screen.getByRole("button", { name: "Threads", exact: true }).click();
    await act(() => requestNavigationMode());
    await userEvent.keyboard("{F6}");
    expect(document.activeElement?.getAttribute("data-keyboard-object")).toBe("Surface controls");
    await userEvent.keyboard(" ");
    await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
    await userEvent.keyboard("i");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.container.querySelector("textarea")),
    );
  },
);

function DeviceSetupDialog() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (details.reason === "close-press") setOpen(next);
      }}
    >
      <DialogPopup aria-label="Set up devices">
        <DialogTitle>Set up devices</DialogTitle>
        <button>Device hub</button>
      </DialogPopup>
    </Dialog>
  );
}

it("leaves a local setup dialog through its dismiss control before returning app keyboard focus", async () => {
  using _mode = setup();
  await using screen = await render(
    <>
      <div data-chat-composer-main-surface>
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
      </div>
      <DeviceSetupDialog />
      <Navigation />
    </>,
  );
  await expect.element(page.getByRole("dialog", { name: "Set up devices" })).toBeVisible();
  await userEvent.keyboard("{Control>}{Shift>} {/Shift}{/Control}");
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("App navigation"),
  );
  expect(document.querySelector('[aria-label="Set up devices"]')).toBeNull();
  await userEvent.keyboard(" ");
  await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
  await userEvent.keyboard("i");
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(screen.container.querySelector("textarea")),
  );
  expect(screen.container.querySelector("textarea")!.value).toBe("Keep this draft");
});

function CustomCloseLayer({ sheet, refuse = false }: { sheet: boolean; refuse?: boolean }) {
  const [open, setOpen] = useState(true);
  const Root = sheet ? Sheet : Dialog;
  const Popup = sheet ? SheetPopup : DialogPopup;
  const Title = sheet ? SheetTitle : DialogTitle;
  return (
    <Root open={open} onOpenChange={(next) => !refuse && setOpen(next)}>
      <Popup showCloseButton={false} aria-label="Custom preview">
        <Title>Custom preview</Title>
        <button onClick={() => setOpen(false)}>Dismiss preview</button>
      </Popup>
    </Root>
  );
}

it.each([false, true])(
  "dismisses a custom-close preview before entering app Normal mode (sheet=%s)",
  async (sheet) => {
    using _mode = setup();
    await using _screen = await render(
      <>
        <CustomCloseLayer sheet={sheet} />
        <Navigation />
      </>,
    );
    await expect.element(page.getByRole("dialog", { name: "Custom preview" })).toBeVisible();
    await userEvent.keyboard("{Control>}{Shift>} {/Shift}{/Control}");
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("App navigation"),
    );
    expect(document.querySelector('[aria-label="Custom preview"]')).toBeNull();
    await userEvent.keyboard(" ");
    await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
  },
);

it("respects a dialog that refuses to close without showing an unreachable Normal mode", async () => {
  using _mode = setup();
  await using _screen = await render(
    <>
      <CustomCloseLayer sheet={false} refuse />
      <Navigation />
    </>,
  );
  await expect.element(page.getByRole("dialog", { name: "Custom preview" })).toBeVisible();
  await userEvent.keyboard("{Control>}{Shift>} {/Shift}{/Control}");
  await act(async () => {
    const layer = document.querySelector('[aria-label="Custom preview"]')!;
    await Promise.allSettled(layer.getAnimations().map((animation) => animation.finished));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect.element(page.getByRole("dialog", { name: "Custom preview" })).toBeVisible();
  expect(isNavigationMode()).toBe(false);
  expect(document.activeElement?.closest('[aria-label="Custom preview"]')).not.toBeNull();
});

function Confirmation({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogPopup aria-label="Delete confirmation">
        <AlertDialogTitle>Delete item?</AlertDialogTitle>
        <button onClick={onDelete}>Delete item</button>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

it("dismisses a confirmation without activating its destructive action", async () => {
  using _mode = setup();
  const onDelete = vi.fn();
  await using _screen = await render(
    <>
      <Confirmation onDelete={onDelete} />
      <Navigation />
    </>,
  );
  await expect.element(page.getByRole("alertdialog", { name: "Delete item?" })).toBeVisible();
  await userEvent.keyboard("{Control>}{Shift>} {/Shift}{/Control}");
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("App navigation"),
  );
  expect(document.querySelector('[aria-label="Delete confirmation"]')).toBeNull();
  expect(onDelete).not.toHaveBeenCalled();
  await userEvent.keyboard(" ");
  await expect.element(page.getByRole("dialog", { name: /Keyboard navigation/ })).toBeVisible();
});
