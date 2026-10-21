import type { EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

const state = vi.hoisted(() => ({
  canOperate: false,
  canWriteSettings: true,
  connected: true,
  keybindings: [] as ResolvedKeybindingsConfig,
  openEditor: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useLocation: (() => "") as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: () => {
    const environment = {
      environmentId: "primary-settings",
      serverConfig: {
        keybindings: state.keybindings,
        keybindingsConfigPath: "/fixture/keybindings.json",
        availableEditors: [],
      },
    };
    return (
      state.connected
        ? { environment, connectedEnvironments: [environment] }
        : { environment: null, connectedEnvironments: [] }
    ) as never;
  },
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId | null, scope: string) =>
    environmentId === "primary-settings" &&
    (scope === "orchestration:operate"
      ? state.canOperate
      : scope === "settings:write" && state.canWriteSettings);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
    useEnvironmentsWithScope: (() =>
      new Set(state.canWriteSettings ? ["primary-settings"] : [])) as never,
  };
});
vi.mock(import("../../editorPreferences"), async (original) => ({
  ...(await original()),
  useOpenInPreferredEditor: ((environmentId: EnvironmentId) => (path: string) =>
    state.openEditor({ environmentId, path })) as never,
}));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

function setup() {
  state.canOperate = false;
  state.canWriteSettings = true;
  state.connected = true;
  state.keybindings = [];
  state.openEditor.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}

const openButton = (container: HTMLElement) => {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open keybindings.json"]',
  );
  expect(button).not.toBeNull();
  return button!;
};

describe("KeybindingsSettings editor permission", () => {
  it("rejects editor launches when settings writes are the only write grant", async () => {
    setup();
    await using screen = await render(<KeybindingsSettingsPanel />, {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    const container = screen.container;
    expect(openButton(container).disabled).toBe(true);
    await act(async () => openButton(container).click());
    expect(state.openEditor).not.toHaveBeenCalled();
  });

  it("opens the primary environment's file after operate is granted without settings writes", async () => {
    setup();
    state.canWriteSettings = false;
    await using screen = await render(<KeybindingsSettingsPanel />, {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    const container = screen.container;
    state.canOperate = true;
    await screen.rerender(<KeybindingsSettingsPanel />);
    expect(openButton(container).disabled).toBe(false);
    await act(async () => openButton(container).click());

    expect(state.openEditor).toHaveBeenCalledWith({
      environmentId: "primary-settings",
      path: "/fixture/keybindings.json",
    });
  });

  it("rejects a queued editor launch after operate is revoked", async () => {
    setup();
    state.canOperate = true;
    await using screen = await render(<KeybindingsSettingsPanel />, {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    const container = screen.container;
    const button = openButton(container);
    state.canOperate = false;
    // The rendered button is still enabled; the click must recheck the live grant.
    await act(async () => button.click());

    expect(state.openEditor).not.toHaveBeenCalled();
    await screen.rerender(<KeybindingsSettingsPanel />);
    expect(openButton(container).disabled).toBe(true);
  });
});

describe("KeybindingsSettings write notice", () => {
  it("asks for a connected environment when none is connected", async () => {
    setup();
    state.connected = false;
    await using screen = await render(<KeybindingsSettingsPanel />, {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    const container = screen.container;
    expect(container.textContent).toContain("Connect an environment to change keybindings.");
  });

  it("names the permission when the connection cannot write settings", async () => {
    setup();
    state.canWriteSettings = false;
    await using screen = await render(<KeybindingsSettingsPanel />, {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    const container = screen.container;
    expect(container.textContent).toContain(
      "This connection can view keybindings but cannot change them.",
    );
  });
});

describe("keyboard binding editing", () => {
  it("moves from the scoped binding search into results and keeps recorder Escape local", async () => {
    setup();
    await using screen = await render(<KeybindingsSettingsPanel />, {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    const container = screen.container;
    const panel = container.querySelector<HTMLElement>('[data-keyboard-object="Keybindings"]')!;
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search keybindings"]')!;
    await act(async () =>
      panel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(search);
    await act(async () =>
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      ),
    );
    const row = container.querySelector<HTMLElement>('[data-keyboard-object="Keybinding"]')!;
    expect(document.activeElement).toBe(row);
    const edit = row.querySelector<HTMLButtonElement>("button[data-keyboard-primary]")!;
    await act(async () => edit.focus());
    await userEvent.keyboard("{Enter}");
    const recorder = row.querySelector<HTMLInputElement>("[data-keybinding-capture]")!;
    expect(document.activeElement).toBe(recorder);
    await act(async () =>
      recorder.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(row.querySelector("[data-keybinding-capture]")).not.toBeNull();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => recorder.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(row.querySelector("[data-keybinding-capture]")).toBeNull();
  });

  it("filters to real conflicting bindings and retains searchable command names", async () => {
    setup();
    const shortcut = parseKeybindingShortcut("ctrl+shift+9")!;
    state.keybindings = [
      { command: "navigation.activate", shortcut },
      { command: "navigation.hints", shortcut },
    ];
    await using screen = await render(<KeybindingsSettingsPanel />, {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    const container = screen.container;
    await userEvent.click(
      container.querySelector<HTMLButtonElement>('[aria-label="Show conflicting keybindings"]')!,
    );
    const rows = [
      ...container.querySelectorAll<HTMLElement>('[data-keyboard-object="Keybinding"]'),
    ];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining(["Navigation: Activate", "Navigation: Focus Hints"]),
    );
    expect(container.textContent).not.toContain("No keybindings match");
  });
});
