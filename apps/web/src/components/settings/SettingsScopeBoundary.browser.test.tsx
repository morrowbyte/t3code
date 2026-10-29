import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { ResolvedSettingsScope } from "./settingsScope";
import { resolveSettingsScope } from "./settingsScope";

const fixture = vi.hoisted(() => ({ scope: null as ResolvedSettingsScope | null }));
vi.mock("./SettingsScopeContext", async (original) => ({
  ...(await original<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({ scope: fixture.scope, connectedEnvironments: [] }),
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
}));

import { SettingsScopeBoundary } from "../../routes/_chat.settings";

function setup(removed: boolean) {
  fixture.scope = resolveSettingsScope(
    { machine: "offline-host" },
    [],
    removed ? [] : [{ environmentId: EnvironmentId.make("offline-host"), label: "Offline host" }],
  );
}

describe("offline settings scope", () => {
  it.each([false, true])("keeps local General controls usable when removed=%s", async (removed) => {
    setup(removed);
    await using screen = await render(
      <SettingsScopeBoundary pathname="/settings/general">
        <label>
          <input type="checkbox" />
          Local notifications
        </label>
      </SettingsScopeBoundary>,
      { router: "/settings/general?machine=offline-host" },
    );
    const checkbox = screen.getByRole("checkbox", { name: "Local notifications" });
    await checkbox.click();
    await expect.element(checkbox).toBeChecked();
  });

  it.each([false, true])("keeps server Voice controls guarded when removed=%s", async (removed) => {
    setup(removed);
    await using screen = await render(
      <SettingsScopeBoundary pathname="/settings/voice">
        <button>Save voice settings</button>
      </SettingsScopeBoundary>,
      { router: "/settings/voice?machine=offline-host" },
    );
    await expect
      .element(
        screen.getByText(
          removed
            ? "This environment is no longer available."
            : "Reconnect Offline host to change its settings.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Save voice settings" }))
      .not.toBeInTheDocument();
  });
});
