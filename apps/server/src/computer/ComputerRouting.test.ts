import { expect, it } from "@effect/vitest";
import type { PreviewAutomationStatus, PreviewTabId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ComputerTarget, selectComputerRoute } from "./ComputerRouting.ts";
import type { DesktopApplication } from "./desktopEntries.ts";

const browser = (id: string, name: string): DesktopApplication => ({
  id,
  name,
  executable: id.replace(".desktop", ""),
  categories: ["WebBrowser"],
  browser: true,
  dbusActivatable: false,
  visible: true,
  terminal: false,
  desktopActions: [],
  flatpakId: null,
  toolkitHint: "unknown",
});
const inventory = {
  platform: "linux",
  complete: true,
  applications: [browser("zen.desktop", "Zen Browser"), browser("chrome.desktop", "Chrome")],
};
const preview: PreviewAutomationStatus = {
  available: true,
  visible: true,
  tabId: "human-tab" as PreviewTabId,
  url: "https://example.com",
  title: "Example",
  loading: false,
  control: { owner: "human", ownedByCaller: false, generation: 1 },
};

it("rejects contradictory preview and system-profile bindings", () => {
  const decode = Schema.decodeUnknownSync(ComputerTarget);
  expect(() => decode({ kind: "web", previewProfileId: "work", browser: "Zen" })).toThrow();
  expect(() =>
    decode({ kind: "web", previewProfileId: "work", systemProfile: "Personal" }),
  ).toThrow();
});

it("uses an independent preview tab for implicit web work while preserving a human tab", () => {
  expect(selectComputerRoute({ kind: "web" }, inventory, preview)).toMatchObject({
    route: "preview",
    interaction: "background",
    reuseExistingTab: false,
  });
  expect(selectComputerRoute({ kind: "web" }, inventory, preview).tabId).toBeUndefined();
  const noTab: PreviewAutomationStatus = {
    available: false,
    visible: false,
    tabId: null,
    url: null,
    title: null,
    loading: false,
    profiles: [{ id: "work", name: "Work" }],
  };
  expect(selectComputerRoute({ kind: "web" }, inventory, noTab)).toMatchObject({
    route: "preview",
    reuseExistingTab: false,
  });
  expect(
    selectComputerRoute({ kind: "web", previewProfileId: "work" }, inventory, noTab),
  ).toMatchObject({
    route: "preview",
    previewProfileId: "work",
    reuseExistingTab: false,
  });
});

it("keeps an explicitly requested browser and system profile even when preview is available", () => {
  expect(
    selectComputerRoute({ kind: "web", browser: "Zen", systemProfile: "Work" }, inventory, preview),
  ).toMatchObject({
    route: "desktop",
    applicationId: "zen.desktop",
    systemProfile: "Work",
    interaction: "capability-dependent",
  });
  expect(selectComputerRoute({ kind: "web", currentSession: true }, inventory, preview).route).toBe(
    "desktop",
  );
});

it("does not replace an unavailable or ambiguous named browser with another one", () => {
  expect(
    selectComputerRoute({ kind: "web", browser: "Firefox" }, inventory, preview),
  ).toMatchObject({
    route: "unavailable",
    reason: "application-unavailable",
  });
  const ambiguous = {
    ...inventory,
    applications: [
      ...inventory.applications,
      { ...browser("zen-dev.desktop", "Zen Developer"), executable: "zen" },
    ],
  };
  expect(selectComputerRoute({ kind: "web", browser: "Zen" }, ambiguous, preview)).toMatchObject({
    route: "unavailable",
    reason: "ambiguous-application",
  });
});

it("does not claim absence or uniqueness from incomplete application discovery", () => {
  for (const applications of [[], inventory.applications.slice(0, 1)]) {
    expect(
      selectComputerRoute(
        { kind: "web", browser: "Zen" },
        {
          ...inventory,
          complete: false,
          applications,
        },
        preview,
      ),
    ).toMatchObject({ route: "unavailable", reason: "inventory-incomplete" });
  }
});

it("requires the specified preview profile and does not silently use a default login", () => {
  expect(
    selectComputerRoute({ kind: "web", previewProfileId: "work" }, inventory, preview),
  ).toMatchObject({
    route: "unavailable",
    reason: "profile-unavailable",
  });
  expect(
    selectComputerRoute({ kind: "web", previewProfileId: "work" }, inventory, null).route,
  ).toBe("unavailable");
});

it("offers the desktop fallback when an unbound web task has no preview", () => {
  expect(selectComputerRoute({ kind: "web" }, inventory, null)).toMatchObject({
    route: "desktop",
    reason: "preview-unavailable",
    interaction: "capability-dependent",
    nextTools: expect.arrayContaining(["desktop_status", "desktop_set_observation_mode"]),
    observationGuidance: expect.stringContaining("successful native result"),
  });
  expect(selectComputerRoute({ kind: "desktop" }, inventory, null)).toMatchObject({
    nextTools: expect.arrayContaining(["desktop_status", "desktop_set_observation_mode"]),
    observationGuidance: expect.stringContaining("Do not require a screenshot"),
  });
});

it("keeps Windows discovery separate from Linux installation evidence", () => {
  expect(
    selectComputerRoute(
      { kind: "web", browser: "Chrome", systemProfile: "Work" },
      {
        platform: "win32",
        complete: false,
        applications: [],
      },
      preview,
    ),
  ).toMatchObject({
    route: "desktop",
    applicationId: "Chrome",
    systemProfile: "Work",
    reason: "native-discovery-required",
    nextTools: ["start_session"],
  });
});
