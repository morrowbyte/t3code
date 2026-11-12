import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import type { RemoteOpenResolution } from "./remoteOpen";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  run: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  remote: new Map<string, RemoteOpenResolution>(),
  openUrl: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId),
}));
vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: state.getPreference,
  setLocalStorageItem: state.setPreference,
  useLocalStorage: vi.fn(),
}));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: (environmentId: string) =>
    state.remote.get(environmentId) ?? { isResolved: true, state: { mode: "local-exec" } },
  useRemoteCapableEditors: () => ["vscode"],
  openRemoteEditorUrl: state.openUrl,
}));

import { useOpenInPreferredEditor } from "./editorPreferences";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");

beforeEach(() => {
  state.allowed.clear();
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.getPreference.mockReset().mockReturnValue(null);
  state.setPreference.mockReset();
  state.remote.clear();
  state.openUrl.mockReset().mockResolvedValue(true);
});

it.each(["local-exec", "remote-links"] as const)(
  "does not use another environment's grant or change preferences when denied (%s)",
  async (mode) => {
    if (mode === "remote-links") {
      state.remote.set(secondary, {
        isResolved: true,
        state: { mode, host: { kind: "ssh-alias", host: "secondary-host" } },
      });
    }
    state.allowed.add(primary);
    const open = useOpenInPreferredEditor(secondary, ["vscode"]);
    const result = await open("/work/readme.md");
    assert(result._tag === "Failure");
    const error = Cause.squash(result.cause);
    expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
    expect(state.run).not.toHaveBeenCalled();
    expect(state.getPreference).not.toHaveBeenCalled();
    expect(state.setPreference).not.toHaveBeenCalled();
    expect(state.openUrl).not.toHaveBeenCalled();
  },
);

it.each(["local-exec", "remote-links"] as const)(
  "checks revocation and regrant when a retained editor callback is invoked (%s)",
  async (mode) => {
    if (mode === "remote-links") {
      state.remote.set(secondary, {
        isResolved: true,
        state: { mode, host: { kind: "ssh-alias", host: "secondary-host" } },
      });
    }
    state.allowed.add(secondary);
    const open = useOpenInPreferredEditor(secondary, mode === "local-exec" ? ["vscode"] : ["zed"]);
    state.allowed.delete(secondary);
    expect((await open("/work/readme.md:5"))._tag).toBe("Failure");
    expect(state.run).not.toHaveBeenCalled();

    state.allowed.add(secondary);
    expect(await open("/work/readme.md:5")).toMatchObject({ _tag: "Success", value: "vscode" });
    if (mode === "remote-links") {
      expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
        "vscode://vscode-remote/ssh-remote+secondary-host/work/readme.md:5:1",
      );
      expect(state.run).not.toHaveBeenCalled();
      state.openUrl.mockClear();
      await open("/work/folder.with.dot", { isFile: false });
      expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
        "vscode://vscode-remote/ssh-remote+secondary-host/work/folder.with.dot",
      );
      state.setPreference.mockClear();
      state.getPreference.mockReturnValue("zed");
      state.openUrl.mockResolvedValueOnce(false);
      const refused = await open("/work/readme.md:5:3");
      assert(refused._tag === "Failure");
      expect(Cause.squash(refused.cause)).toMatchObject({
        environmentId: secondary,
        targetPath: "/work/readme.md:5:3",
        editor: "vscode",
      });
      expect(state.run).not.toHaveBeenCalled();
      expect(state.setPreference).not.toHaveBeenCalled();
      expect(await open("/work/readme.md:5:3")).toMatchObject({
        _tag: "Success",
        value: "vscode",
      });
      expect(state.setPreference).toHaveBeenCalledExactlyOnceWith(
        "t3code:last-editor",
        "vscode",
        expect.anything(),
      );
      return;
    }
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: secondary,
      input: { cwd: "/work/readme.md:5", editor: "vscode" },
    });
    expect(state.setPreference).toHaveBeenCalledTimes(1);
    expect(state.openUrl).not.toHaveBeenCalled();
  },
);

it.each([
  { isResolved: false, state: { mode: "local-exec" } },
  { isResolved: true, state: { mode: "remote-unavailable" } },
] satisfies RemoteOpenResolution[])(
  "does not run a server editor while remote capability is unavailable ($isResolved/$state.mode)",
  async (remote) => {
    state.allowed.add(secondary);
    state.remote.set(secondary, remote);
    const result = await useOpenInPreferredEditor(secondary, ["zed"])("/work/readme.md");
    assert(result._tag === "Failure");
    expect(Cause.squash(result.cause)).toMatchObject({
      environmentId: secondary,
      availableEditorIds: [],
    });
    expect(state.run).not.toHaveBeenCalled();
    expect(state.openUrl).not.toHaveBeenCalled();
  },
);
