import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import FileBrowserPanel from "./FileBrowserPanel";

const files = vi.hoisted(() => ({
  directoryEntries: [] as ProjectEntry[],
  searchEntries: [] as ProjectEntry[],
  searchPending: false,
  searchError: null as string | null,
  loadingDirectories: new Set<string>() as ReadonlySet<string>,
  load: vi.fn(async () => {}),
  refresh: vi.fn(),
  insert: vi.fn(() => true),
}));

vi.mock("./useDirectoryEntries", () => ({
  useDirectoryEntries: () => ({
    entries: files.directoryEntries,
    loadingDirectories: files.loadingDirectories,
    load: files.load,
    refresh: files.refresh,
    ready: true,
    error: null,
    isPending: false,
  }),
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({
    entries: files.searchEntries,
    isPending: files.searchPending,
    error: files.searchError,
    truncated: false,
    refresh: files.refresh,
  }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: vi.fn() }));
vi.mock("~/composerHandleContext", () => ({
  useComposerHandleContext: () => ({ current: { insertTextAtEnd: files.insert } }),
}));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenu: () => ({}) }));
vi.mock("~/localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

describe("Files panel search", () => {
  function setup() {
    files.directoryEntries = [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file" },
      { path: "package.json", kind: "file" },
    ];
    files.searchEntries = [];
    files.searchPending = false;
    files.searchError = null;
    files.loadingDirectories = new Set();
    files.load.mockClear();
    files.refresh.mockClear();
    files.insert.mockClear();
    const props = {
      environmentId: EnvironmentId.make("test-environment"),
      cwd: "/workspace",
      projectName: "Test project",
      selectedPath: null,
      selectedPathRevealId: 0,
      onOpenFile: vi.fn(),
      workspaceMutationId: null,
    };
    const container = document.createElement("div");
    // The tree virtualizes its rows, so it needs a real viewport to render any.
    container.style.cssText = "display: flex; flex-direction: column; width: 320px; height: 480px;";
    return { props, container };
  }

  function searchInput(container: HTMLElement) {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    return input!;
  }

  async function search(container: HTMLElement, value: string) {
    const input = searchInput(container);
    // React tracks the last value it saw on the element, so set it through the native setter.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function visiblePaths(container: HTMLElement) {
    const tree = container.querySelector("file-tree-container");
    if (!tree) return [];
    return [...tree.shadowRoot!.querySelectorAll("[data-item-path]")].map((row) =>
      row.getAttribute("data-item-path"),
    );
  }

  function hasMessage(container: HTMLElement, message: string) {
    return [...container.querySelectorAll("div")].some(
      (node) => node.childNodes.length === 1 && node.textContent === message,
    );
  }

  it("shows no matching files instead of the full tree when a filename is absent", async () => {
    const { props, container } = setup();
    await using _screen = await render(<FileBrowserPanel {...props} />, {
      container,
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    expect(visiblePaths(container)).toEqual(["src/", "package.json"]);

    await search(container, ".env.local");
    expect(visiblePaths(container)).toEqual([]);
    expect(hasMessage(container, "No matching files.")).toBe(true);

    await search(container, "package");
    expect(visiblePaths(container)).toEqual(["package.json"]);
    expect(hasMessage(container, "No matching files.")).toBe(false);

    await search(container, "");
    expect(visiblePaths(container)).toEqual(["src/", "package.json"]);
  });

  it("moves through the tree with j/k and attaches a selected path without a context menu", async () => {
    const { props, container } = setup();
    await using _screen = await render(<FileBrowserPanel {...props} />, {
      container,
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    const tree = container.querySelector("file-tree-container")!;
    const row = tree.shadowRoot!.querySelector<HTMLElement>('[data-item-path="package.json"]')!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true, button: 0, detail: 1 }),
      );
      row.focus();
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true, cancelable: true }),
      );
    });
    expect(files.insert).toHaveBeenCalledWith(expect.stringContaining("package.json"), {
      ensureLeadingBoundary: true,
    });
    await act(async () =>
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", bubbles: true, composed: true, cancelable: true }),
      ),
    );
    expect(tree.shadowRoot!.activeElement?.getAttribute("data-item-path")).toBe("src/");
    await act(async () =>
      tree.shadowRoot!.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", bubbles: true, composed: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(searchInput(container));
    await act(async () =>
      searchInput(container).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(tree));
  });

  it("still finds ignored files already loaded from a directory", async () => {
    const { props, container } = setup();
    files.directoryEntries.push({ path: ".env.local", kind: "file", ignored: true });
    await using _screen = await render(<FileBrowserPanel {...props} />, {
      container,
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    await search(container, ".env.local");
    expect(visiblePaths(container)).toEqual([".env.local"]);
    expect(hasMessage(container, "No matching files.")).toBe(false);
  });

  it("waits for remote matches without showing unrelated files or a premature empty result", async () => {
    const { props, container } = setup();
    await using _screen = await render(<FileBrowserPanel {...props} />, {
      container,
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    files.searchPending = true;
    await search(container, "settings.ts");
    expect(visiblePaths(container)).toEqual([]);
    expect(hasMessage(container, "Loading files…")).toBe(true);
    expect(hasMessage(container, "No matching files.")).toBe(false);

    files.searchEntries = [{ path: "config/settings.ts", kind: "file" }];
    files.searchPending = false;
    await _screen.rerender(<FileBrowserPanel {...props} />);
    expect(visiblePaths(container)).toEqual(["config/", "config/settings.ts"]);
    expect(hasMessage(container, "No matching files.")).toBe(false);
  });

  it("restores the tree on Escape after an unsuccessful search", async () => {
    const { props, container } = setup();
    await using _screen = await render(<FileBrowserPanel {...props} />, {
      container,
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    await search(container, "missing-file");
    expect(visiblePaths(container)).toEqual([]);

    const input = searchInput(container);
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.activeElement).not.toBe(input);
    expect(visiblePaths(container)).toEqual(["src/", "package.json"]);
    expect(hasMessage(container, "No matching files.")).toBe(false);
  });

  it("does not report an empty result when the search failed", async () => {
    const { props, container } = setup();
    await using _screen = await render(<FileBrowserPanel {...props} />, {
      container,
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    });
    files.searchError = "Workspace search failed.";
    await search(container, "missing-file");
    expect(visiblePaths(container)).toEqual([]);
    expect(hasMessage(container, "No matching files.")).toBe(false);
    expect(container.textContent).toContain("Workspace search failed.");
  });
});
