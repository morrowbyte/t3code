import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  prepared: { _tag: "Some", value: { session: "first" } },
  request: vi.fn(),
  listeners: new Set<() => void>(),
}));

vi.mock("../../voice/voiceSettingsClient", () => ({
  voiceSettingsRequest: state.request,
  voiceSettingsErrorMessage: () => "Could not save voice settings.",
}));
vi.mock("../../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePreparedConnection: () =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => {
            state.listeners.delete(listener);
          };
        },
        () => state.prepared,
      ),
    useEnvironmentScope: () => true,
  };
});
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentId: "environment-a" },
    target: { environmentId: "environment-a" },
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ control }: { control: ReactNode }) => <div>{control}</div>,
}));

import { VoiceDiagnosticsSettings } from "./VoiceDiagnosticsSettings";

it("ignores a save from the previous connection after reconnecting the same environment", async () => {
  state.prepared = { _tag: "Some", value: { session: "first" } };
  state.listeners.clear();
  const settings = {
    provider: "codex-account",
    instanceId: null,
    model: "default",
    diagnosticsEnabled: false,
  };
  let completeSave: (value: typeof settings) => void = () => {
    throw new Error("Save did not start");
  };
  state.request.mockReset().mockImplementation((_environmentId: string, update: unknown) =>
    update
      ? new Promise<typeof settings>((resolve) => {
          completeSave = resolve;
        })
      : Promise.resolve(settings),
  );
  await using screen = await render(<VoiceDiagnosticsSettings />);
  const toggle = screen.getByRole("switch", { name: "Capture voice diagnostic events" });
  await expect.element(toggle).toBeEnabled();
  toggle.element().focus();
  await userEvent.keyboard(" ");
  await expect.element(toggle).toBeDisabled();

  await act(async () => {
    state.prepared = { _tag: "Some", value: { session: "second" } };
    for (const listener of state.listeners) listener();
  });
  await expect.element(toggle).toBeEnabled();
  await act(async () => {
    completeSave({ ...settings, diagnosticsEnabled: true });
  });
  await expect.element(toggle).not.toBeChecked();
});
