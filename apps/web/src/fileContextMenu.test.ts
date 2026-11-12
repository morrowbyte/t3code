import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RemoteOpenResolution } from "./remoteOpen";

const state = vi.hoisted(() => ({
  remote: new Map<string, RemoteOpenResolution>(),
  run: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (value: unknown) => value,
}));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./localApi", () => ({ readLocalApi: vi.fn() }));
vi.mock("./state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => ({
      availableEditors: ["zed", "file-manager"],
      shellRevealInFileManager: true,
      shellRevealInFileManagerKind: "file-explorer",
      environment: { label: "Work", platform: { os: "linux" } },
    }),
  },
}));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./fileApps", () => ({
  useFileApps: () => ({ appsForPath: () => [], open: vi.fn() }),
}));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: (environmentId: string) => state.remote.get(environmentId),
  useRemoteCapableEditors: () => ["vscode"],
  openRemoteEditorUrl: state.openUrl,
}));

import { resolveFileContextMenuAbsolutePath, useFileContextMenu } from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

describe("resolveFileContextMenuAbsolutePath", () => {
  it("strips the repository prefix when the repo root is nested in the workspace", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("/workspace/project/packages/app/src/index.ts");
  });

  it("returns null for paths outside the workspace when a repository root is set", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("rejects absolute paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBeNull();
  });
});

describe("file context menu environment routing", () => {
  function setup() {
    state.remote.clear();
    state.run.mockReset().mockResolvedValue({ _tag: "Success" });
    state.openUrl.mockReset().mockResolvedValue(true);
  }

  it("uses each same-named environment's remote editor host, including a retained menu", async () => {
    setup();
    const first = EnvironmentId.make("work-first");
    const second = EnvironmentId.make("work-second");
    for (const [environmentId, host] of [
      [first, "first-host"],
      [second, "second-host"],
    ] as const) {
      state.remote.set(environmentId, {
        isResolved: true,
        state: { mode: "remote-links", host: { kind: "ssh-alias", host } },
      });
    }
    const firstMenu = useFileContextMenu(first);
    const secondMenu = useFileContextMenu(second);
    for (const [environmentId, menu, host] of [
      [second, secondMenu, "second-host"],
      [first, firstMenu, "first-host"],
    ] as const) {
      const target = { ...BASE_TARGET, environmentId };
      expect(menu.buildItems(target)).toEqual([
        {
          id: "open-with",
          label: "Open with",
          children: [{ id: "editor:vscode", label: "VS Code" }],
        },
      ]);
      await menu.activate("editor:vscode", target);
      expect(state.openUrl).toHaveBeenLastCalledWith(
        `vscode://vscode-remote/ssh-remote+${host}/workspace/project/src/index.ts:1:1`,
      );
      await menu.activate("editor:vscode", { ...target, filePath: "src", isDirectory: true });
      expect(state.openUrl).toHaveBeenLastCalledWith(
        `vscode://vscode-remote/ssh-remote+${host}/workspace/project/src`,
      );
    }
    await firstMenu.activate("editor:vscode", { ...BASE_TARGET, environmentId: second });
    expect(state.openUrl).toHaveBeenCalledTimes(4);
    expect(state.run).not.toHaveBeenCalled();
  });

  it.each([
    { isResolved: false, state: { mode: "local-exec" } },
    { isResolved: true, state: { mode: "remote-unavailable" } },
  ] satisfies RemoteOpenResolution[])(
    "offers no server editor when remote state is $state.mode (resolved: $isResolved)",
    async (remote) => {
      setup();
      state.remote.set(BASE_TARGET.environmentId, remote);
      const menu = useFileContextMenu(BASE_TARGET.environmentId);
      expect(menu.buildItems(BASE_TARGET)).toEqual([]);
      await menu.activate("editor:zed", BASE_TARGET);
      await menu.activate("reveal-in-folder", BASE_TARGET);
      expect(state.run).not.toHaveBeenCalled();
      expect(state.openUrl).not.toHaveBeenCalled();
    },
  );

  it("keeps the target environment's Windows Explorer reveal for a desktop-owned WSL project", async () => {
    setup();
    state.remote.set(BASE_TARGET.environmentId, {
      isResolved: true,
      state: { mode: "local-exec" },
    });
    const menu = useFileContextMenu(BASE_TARGET.environmentId);
    expect(menu.capabilities.revealLabel).toBe("Reveal in File Explorer");
    await menu.activate("reveal-in-folder", BASE_TARGET);
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: BASE_TARGET.environmentId,
      input: { cwd: "/workspace/project/src/index.ts", editor: "file-manager", reveal: true },
    });
    expect(state.openUrl).not.toHaveBeenCalled();
  });
});
