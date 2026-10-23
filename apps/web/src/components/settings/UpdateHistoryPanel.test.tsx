// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { HostUpdateRecord } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

const state = vi.hoisted(() => ({
  allowed: true,
  confirm: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  entries: [] as HostUpdateRecord[],
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "permission"
      ? state.allowed
      : {
          _tag: "Success",
          value: { entries: state.entries, desktop: "available" },
        },
  useAtomRefresh: () => state.refresh,
}));
vi.mock("../../state/updateHistory", () => ({
  hostUpdateHistory: () => "history",
  deleteHostUpdateHistory: { permissionAtom: () => "permission" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.remove }));
vi.mock("../../confirmDialog", () => ({
  requestConfirmDialog: (...args: unknown[]) => state.confirm(...args),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    connectedEnvironments: [
      {
        environmentId: "host",
        label: "DevBox",
        serverConfig: { environment: { capabilities: { updateHistory: true } } },
      },
    ],
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
import { UpdateHistoryPanel } from "./UpdateHistoryPanel";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.allowed = true;
  state.confirm.mockReset();
  state.remove.mockReset();
  state.remove.mockResolvedValue(AsyncResult.success(undefined));
  state.refresh.mockReset();
  const now = "2026-10-17T00:00:00.000Z";
  state.entries = [
    {
      id: "completed",
      component: "desktop",
      fromVersion: "1.0.0",
      targetVersion: "1.1.0",
      observedVersion: "1.0.0",
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      status: "failed",
      error: "Installer failed. Check installer logs before retrying.",
    },
  ];
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () => {
    root.render(<UpdateHistoryPanel />);
  });
const deleteButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Delete"]')!;
const clickDelete = () =>
  act(async () => {
    deleteButton().click();
  });

it("reopens the saved host result without mutating it and requires confirmation before deletion", async () => {
  await render();
  expect(container.textContent).toContain("DevBox");
  expect(container.textContent).toContain("1.0.0 → 1.1.0");
  expect(container.textContent).toContain("Check installer logs");
  expect(state.remove).not.toHaveBeenCalled();
  state.confirm.mockResolvedValue(false);
  await clickDelete();
  expect(state.remove).not.toHaveBeenCalled();
  await act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain("Installer failed");
  state.confirm.mockResolvedValue(true);
  await clickDelete();
  expect(state.remove).toHaveBeenCalledWith({
    environmentId: "host",
    input: { component: "desktop", id: "completed" },
  });
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("denies deletion without host maintenance permission and keeps active receipts visible", async () => {
  state.allowed = false;
  await render();
  expect(deleteButton().disabled).toBe(true);
  await clickDelete();
  expect(state.confirm).not.toHaveBeenCalled();
  state.entries = [
    {
      ...state.entries[0]!,
      id: "pending",
      completedAt: null,
      status: "awaiting-restart",
      error: null,
    },
  ];
  await render();
  expect(container.textContent).toContain("Awaiting restart confirmation");
  expect(container.querySelector('button[aria-label^="Delete"]')).toBeNull();
  expect(state.remove).not.toHaveBeenCalled();
});
