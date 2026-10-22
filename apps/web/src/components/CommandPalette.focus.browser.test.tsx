import { useImperativeHandle, useRef } from "react";
import { act, fakeTimers, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { CommandPalette } from "./CommandPalette";
import { useComposerHandleContext } from "../composerHandleContext";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";
import { LeaderNavigation } from "./keyboard/LeaderNavigation";
import { isNavigationMode, leaveNavigationMode } from "./keyboard/navigationMode";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useParams: () => null,
  useLocation: () => "/settings",
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...original,
    useAtomValue: (atom: unknown) =>
      atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
  };
});
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "default", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => ({}),
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => vi.fn() }));
vi.mock("../hooks/useHandleNewThread", () => ({ useHandleNewThread: () => ({}) }));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useProjects: () => [],
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../state/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/queries")>()),
  useThreadSearch: () => ({ matches: [] }),
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  useEnvironmentScope: () => false,
}));
vi.mock("../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({}),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

function setup() {
  const resources = new AsyncDisposableStack();
  resources.use(fakeTimers());
  resources.defer(async () => {
    await act(() => vi.runOnlyPendingTimersAsync());
    leaveNavigationMode();
  });
  return resources.move();
}

async function flushFocus() {
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

async function dismissPalette() {
  await act(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    ),
  );
  await flushFocus();
  expect(document.querySelector("[data-command-palette]")).toBeNull();
}

function Composer() {
  const handle = useComposerHandleContext();
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(
    handle,
    () =>
      ({
        focusAtEnd: () => {
          input.current?.focus();
          input.current?.setSelectionRange(input.current.value.length, input.current.value.length);
        },
      }) as NonNullable<NonNullable<typeof handle>["current"]>,
  );
  return <textarea ref={input} aria-label="Composer" defaultValue="Draft prompt" />;
}

describe("command palette focus restoration", () => {
  it("closes the palette for app Normal mode before Space opens Which-Key", async () => {
    await using _resources = setup();
    await using _screen = await render(
      <CommandPalette>
        <textarea aria-label="Previous input" />
        <LeaderNavigation
          groups={[]}
          isClaimed={() => false}
          showSidebar={() => {}}
          isActivationShortcut={(event) => event.key === " " && event.ctrlKey && event.shiftKey}
        />
      </CommandPalette>,
      {
        // Standalone keyboard fixture; route navigation is outside this scenario.
        router: false,
      },
    );
    await act(() => openCommandPalette());
    await flushFocus();
    await act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    await flushFocus();
    expect(document.querySelector("[data-command-palette]")).toBeNull();
    expect(isNavigationMode()).toBe(true);
    await act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    expect(document.querySelector('[aria-label="Keyboard navigation"]')).not.toBeNull();
  });
  it("returns to the previously focused Settings field when no composer is mounted", async () => {
    await using _setup = setup();
    await using screen = await render(
      <CommandPalette>
        <input aria-label="Settings field" />
      </CommandPalette>,
      {
        // Standalone keyboard fixture; route navigation is outside this scenario.
        router: false,
      },
    );
    const container = screen.container;
    const field = container.querySelector("input")!;
    await act(() => field.focus());
    await act(() => openCommandPalette());
    await flushFocus();
    expect(document.activeElement?.closest("[data-command-palette]")).not.toBeNull();
    await dismissPalette();
    expect(document.activeElement).toBe(field);
  });

  it("focuses the replacement command input after leaving the file picker", async () => {
    await using _setup = setup();
    await using screen = await render(
      <CommandPalette>
        <input aria-label="Settings field" />
      </CommandPalette>,
      {
        // Standalone keyboard fixture; route navigation is outside this scenario.
        router: false,
      },
    );
    const container = screen.container;
    const field = container.querySelector("input")!;
    await act(() => field.focus());
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "p",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    expect(document.querySelector('[data-palette-mode="files"]')).not.toBeNull();
    await act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    expect(document.activeElement?.closest('[data-palette-mode="command"]')).not.toBeNull();
    expect(document.activeElement?.tagName).toBe("INPUT");
    await dismissPalette();
    expect(document.activeElement).toBe(field);
  });

  it("restores the previous field even when a composer is mounted", async () => {
    await using _setup = setup();
    await using screen = await render(
      <CommandPalette>
        <input aria-label="Previous field" />
        <Composer />
      </CommandPalette>,
      {
        // Standalone keyboard fixture; route navigation is outside this scenario.
        router: false,
      },
    );
    const container = screen.container;
    await act(() => container.querySelector("input")!.focus());
    await act(() => openCommandPalette());
    await flushFocus();
    expect(document.activeElement?.closest("[data-command-palette]")).not.toBeNull();
    await dismissPalette();
    expect(document.activeElement).toBe(container.querySelector("input"));
  });

  it("restores the original composer selection when canceled", async () => {
    await using _setup = setup();
    await using screen = await render(
      <CommandPalette>
        <Composer />
      </CommandPalette>,
      {
        // Standalone keyboard fixture; route navigation is outside this scenario.
        router: false,
      },
    );
    const container = screen.container;
    const composer = container.querySelector("textarea")!;
    await act(() => {
      composer.focus();
      composer.setSelectionRange(2, 7, "backward");
      openCommandPalette();
    });
    await flushFocus();
    await dismissPalette();
    expect(document.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe(2);
    expect(composer.selectionEnd).toBe(7);
    expect(composer.selectionDirection).toBe("backward");
  });

  it("runs an action on the object that opened the command palette", async () => {
    await using _setup = setup();
    const first = vi.fn();
    const second = vi.fn();
    await using screen = await render(
      <CommandPalette>
        <div data-keyboard-object="Message" tabIndex={-1}>
          <button onClick={first}>Copy first response</button>
        </div>
        <div data-keyboard-object="Message" tabIndex={-1}>
          <button onClick={second}>Copy second response</button>
        </div>
        <Composer />
        <LeaderNavigation groups={[]} isClaimed={() => false} showSidebar={() => {}} />
      </CommandPalette>,
      {
        // Standalone keyboard fixture; route navigation is outside this scenario.
        router: false,
      },
    );
    const container = screen.container;
    const message = container.querySelectorAll<HTMLElement>("[data-keyboard-object]")[1]!;
    await act(() => {
      message.focus();
      openCommandPalette({ query: "Selected object actions" });
    });
    await flushFocus();
    await act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    await act(() => vi.advanceTimersByTimeAsync(300));
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) =>
        element.textContent?.includes("Copy second response") && element.closest('[role="dialog"]'),
    );
    expect(action).toBeDefined();
    await act(() => action!.click());
    await flushFocus();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
