import { AuthOrchestrationOperateScope, EnvironmentId, type EditorId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render as renderUi } from "../../../test/render";
import type { RemoteOpenState } from "../../remoteOpen";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { resolveMarkdownFileLinkMeta } from "../../markdown-links";
import { resolveMarkdownFileHostPath } from "../../markdownFileHostPath";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  remote: { mode: "local-exec" } as RemoteOpenState,
  clientEditors: ["vscode"] as readonly EditorId[],
  run: vi.fn(),
  openUrl: vi.fn(),
  setPreferred: vi.fn(),
  markHintSeen: vi.fn(),
  listeners: new Set<() => void>(),
}));

vi.mock(import("../../state/session"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId);
  return {
    ...(await importOriginal()),
    readEnvironmentScope: readEnvironmentScope as never,
    useEnvironmentScope: ((environmentId: string, scope: string) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(environmentId, scope),
      )) as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({ label: "Test host" })) as never,
}));
vi.mock(import("../../editorPreferences"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    usePreferredEditor: (available: readonly EditorId[]) => {
      const [preferred, setPreferred] = actual.usePreferredEditor(available);
      const recordPreferred: typeof setPreferred = (editor) => {
        state.setPreferred(editor);
        setPreferred(editor);
      };
      return [preferred, recordPreferred] as const;
    },
  };
});
vi.mock(import("../../remoteOpen"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRemoteOpenState: () => state.remote,
  useRemoteCapableEditors: () => state.clientEditors,
  useRemoteOpenHint: () => [false, state.markHintSeen] as const,
  openRemoteEditorUrl: state.openUrl,
}));

import { OpenInPicker } from "./OpenInPicker";
import {
  registerOpenFavoriteEditorCommand,
  useOpenFavoriteEditorShortcut,
} from "./OpenInPickerShortcut";

const primary = EnvironmentId.make("primary");
const selected = EnvironmentId.make("selected");
const editors: readonly EditorId[] = ["vscode"];

function announcementTimers(): AsyncDisposable {
  const timers = fakeTimers();
  return {
    async [Symbol.asyncDispose]() {
      try {
        await act(() => vi.runOnlyPendingTimers());
        for (const region of document.querySelectorAll('body > [aria-live="polite"]')) {
          region.textContent = "";
        }
      } finally {
        timers[Symbol.dispose]();
      }
    },
  };
}

async function setup(platform = "Linux") {
  state.allowed.clear();
  state.remote = { mode: "local-exec" };
  state.clientEditors = editors;
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openUrl.mockReset().mockResolvedValue(true);
  state.setPreferred.mockReset();
  state.markHintSeen.mockReset();
  state.listeners.clear();
  window.localStorage.clear();

  await using stack = new AsyncDisposableStack();
  const _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  stack.use(_platform);
  const _storage = { [Symbol.dispose]: () => window.localStorage.clear() };
  stack.use(_storage);
  // The app registers this command at startup (appInit).
  const _openFavorite = { [Symbol.dispose]: registerOpenFavoriteEditorCommand() };
  stack.use(_openFavorite);
  const screen = stack.use(await renderUi(null));
  async function renderPicker(
    availableEditors: readonly EditorId[] = editors,
    panel = false,
    { openInCwd = "/work/project", revealFileManager = false, openOnSelect = false } = {},
  ) {
    await act(async () => {
      for (const listener of state.listeners) listener();
      const node = (
        <OpenInPicker
          environmentId={selected}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          availableEditors={availableEditors}
          openInCwd={openInCwd}
          revealFileManager={revealFileManager}
          openOnSelect={openOnSelect}
          displayMode={panel ? "panel" : "toolbar"}
          compact={!panel}
        />
      );
      await screen.rerender(node);
    });
  }

  function byLabel(label: string) {
    const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    expect(element, label).not.toBeNull();
    return element!;
  }

  const primaryButton = () => byLabel("Open file in preferred editor");
  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }

  async function pressOpenFavorite(mac = false) {
    const event = new KeyboardEvent("keydown", {
      key: "o",
      ctrlKey: !mac,
      metaKey: mac,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => document.body.dispatchEvent(event));
    return event;
  }

  function FavoriteEditorFallback() {
    useOpenFavoriteEditorShortcut({
      enabled: true,
      environmentId: selected,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      availableEditors: editors,
      openInCwd: "/work/project",
    });
    return null;
  }

  const environment = stack.move();
  return {
    screen,
    renderPicker,
    byLabel,
    primaryButton,
    menuItems,
    click,
    pressOpenFavorite,
    FavoriteEditorFallback,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("host editor access", () => {
  it.each([
    "D:\\projects\\sample-project\\file-preview\\network-diagram.html",
    "D:\\projects\\sample project\\file preview\\network diagram.html",
  ])("reveals %s from the file toolbar menu and retains Ctrl+O", async (filePath) => {
    await using fixture = await setup("Win32");
    state.allowed.add(selected);
    const workspaceRoot = filePath.slice(0, filePath.lastIndexOf("\\"));
    const meta = resolveMarkdownFileLinkMeta(filePath, workspaceRoot);
    if (!meta) throw new Error("Expected the Windows file link");
    const { absolutePath: chatPath } = await resolveMarkdownFileHostPath({
      meta,
      cwd: workspaceRoot,
      findWorkspaceMatch: async () => null,
    });
    expect(chatPath).toBe(filePath);
    const previewPath = resolvePathLinkTarget(filePath, workspaceRoot);
    expect(previewPath).toBe(chatPath);
    await fixture.renderPicker(["zed", "file-manager"], false, {
      openInCwd: previewPath,
      revealFileManager: true,
      openOnSelect: true,
    });

    await userEvent.click(fixture.screen.getByRole("button", { name: "Choose editor" }));
    await userEvent.click(page.getByRole("menuitem", { name: "File Explorer" }));
    const revealRequest = {
      environmentId: selected,
      input: { cwd: chatPath, editor: "file-manager", reveal: true },
    };
    expect(state.run).toHaveBeenCalledExactlyOnceWith(revealRequest);
    expect(state.openUrl).not.toHaveBeenCalled();

    await using _announcements = announcementTimers();
    expect((await fixture.pressOpenFavorite()).defaultPrevented).toBe(true);
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(state.run).toHaveBeenLastCalledWith(revealRequest);
  });

  it("keeps workspace and folder toolbar selection as a preference until Open", async () => {
    await using fixture = await setup("Win32");
    state.allowed.add(selected);
    const folderPath = "D:\\projects\\workspace with spaces";
    await fixture.renderPicker(["zed", "file-manager"], false, { openInCwd: folderPath });

    await userEvent.click(fixture.screen.getByRole("button", { name: "Choose editor" }));
    await userEvent.click(page.getByRole("menuitem", { name: "File Explorer" }));
    expect(state.run).not.toHaveBeenCalled();
    await using _announcements = announcementTimers();
    await userEvent.click(
      fixture.screen.getByRole("button", { name: "Open file in preferred editor" }),
    );
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: selected,
      input: { cwd: folderPath, editor: "file-manager" },
    });
  });

  it("opens a file in Zed without the file-manager reveal flag", async () => {
    await using fixture = await setup("Win32");
    state.allowed.add(selected);
    const filePath = "D:\\projects\\workspace with spaces\\network diagram.html";
    await fixture.renderPicker(["zed", "file-manager"], false, {
      openInCwd: filePath,
      revealFileManager: true,
      openOnSelect: true,
    });

    await userEvent.click(fixture.screen.getByRole("button", { name: "Choose editor" }));
    await userEvent.click(page.getByRole("menuitem", { name: /^Zed/ }));
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: selected,
      input: { cwd: filePath, editor: "zed" },
    });
  });

  it.each([
    ["picker", "dialog"],
    ["picker", "local"],
    ["fallback", "dialog"],
    ["fallback", "local"],
  ] as const)("leaves Ctrl+O with the %s's %s keyboard owner", async (entry, owner) => {
    await using fixture = await setup();
    state.allowed.add(selected);
    let historyMoves = 0;
    const Fallback = fixture.FavoriteEditorFallback;
    await fixture.screen.rerender(
      <>
        {entry === "picker" ? (
          <OpenInPicker
            environmentId={selected}
            keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
            availableEditors={editors}
            openInCwd="/work/project"
          />
        ) : (
          <Fallback />
        )}
        <div
          role={owner === "dialog" ? "dialog" : undefined}
          data-keyboard-local={owner === "local" ? "true" : undefined}
          onKeyDown={(event) => {
            if (event.ctrlKey && event.key === "o") {
              historyMoves++;
              event.preventDefault();
            }
          }}
        >
          <textarea aria-label="Review source" />
        </div>
      </>,
    );
    await userEvent.click(fixture.screen.getByRole("textbox", { name: "Review source" }));
    await userEvent.keyboard("{Control>}o{/Control}");
    expect(historyMoves).toBe(1);
    expect(state.run).not.toHaveBeenCalled();
    expect(state.openUrl).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();
  });

  it("uses the selected grant for both the button and a retained shortcut", async () => {
    await using fixture = await setup();
    const { renderPicker, byLabel, primaryButton, click, pressOpenFavorite } = fixture;
    state.allowed.add(selected);
    await renderPicker();
    // Revoke without rerendering to exercise execution-time grant checks.
    state.allowed.delete(selected);
    state.allowed.add(primary);
    await click(primaryButton());
    // The shortcut is consumed and opens nothing once the grant is gone.
    expect((await pressOpenFavorite()).defaultPrevented).toBe(true);
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();

    await renderPicker();
    expect(primaryButton().disabled).toBe(true);
    expect(byLabel("Choose editor").disabled).toBe(true);
    expect((await pressOpenFavorite()).defaultPrevented).toBe(false);
  });
});

describe("remote editor links", () => {
  it("opens the link from the fallback when the picker is not mounted", async () => {
    await using fixture = await setup();
    const { screen, pressOpenFavorite, FavoriteEditorFallback } = fixture;
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } };
    await act(async () => screen.rerender(<FavoriteEditorFallback />));
    await using _announcements = announcementTimers();

    expect((await pressOpenFavorite()).defaultPrevented).toBe(true);
    expect(state.openUrl).toHaveBeenCalledWith(expect.stringContaining("ssh-remote+sol"));
    expect(state.run).not.toHaveBeenCalled();
  });
});

describe("open in editor announcement", () => {
  it("speaks only after the shortcut opened the editor, from the picker or the fallback", async () => {
    await using fixture = await setup();
    const { screen, renderPicker, pressOpenFavorite, FavoriteEditorFallback } = fixture;
    state.allowed.add(selected);
    await renderPicker();
    await using _announcements = announcementTimers();
    const regions = () => [...document.querySelectorAll('body > [aria-live="polite"]')];
    const spoken = async () => {
      await act(async () => vi.runAllTimers());
      return regions()
        .map((region) => region.textContent)
        .join("");
    };
    const refuse = () =>
      state.run.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("No editor"))));

    refuse();
    await pressOpenFavorite();
    expect(await spoken()).toBe("");
    await pressOpenFavorite();
    expect(await spoken()).toBe("Opened in VS Code");

    for (const region of regions()) region.textContent = "";
    await act(async () => screen.rerender(<FavoriteEditorFallback />));
    refuse();
    await pressOpenFavorite();
    expect(await spoken()).toBe("");
    await pressOpenFavorite();
    expect(await spoken()).toBe("Opened in VS Code");
  });
});
