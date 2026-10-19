import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type LinearAction,
  type LinearSettings,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import "../../index.css";

const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  singleEnvironment: true,
  scopes: [] as string[],
}));
vi.mock(import("../../linear/linearClient"), async (original) => ({
  ...(await original()),
  linearRequest: fixture.request,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() =>
    fixture.singleEnvironment
      ? {
          scope: { kind: "environment", environmentId: "fixture-env" },
          target: { environmentId: "fixture-env" },
        }
      : { scope: { kind: "all" }, target: null }) as never,
  useOptionalSettingsScope: () => null,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (_environmentId: unknown, scope: string) => fixture.scopes.includes(scope),
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { environmentId: "fixture-env", id: "fixture-project", title: "Fixture project" },
  ]) as never,
  useThreadShells: (() => [
    {
      environmentId: "fixture-env",
      projectId: "fixture-project",
      id: "fixture-thread",
      title: "Existing owner thread",
      archivedAt: null,
      deletedAt: null,
    },
  ]) as never,
}));

import { LinearSettingsPanel } from "./LinearSettings";
let root: Root;
let container: HTMLDivElement;
let settings: LinearSettings;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.singleEnvironment = true;
  fixture.scopes = ["orchestration:read", "settings:write", "orchestration:operate"];
  settings = {
    enabled: false,
    environmentId: EnvironmentId.make("fixture-env"),
    oauthConfigured: false,
    webhookConfigured: false,
    connection: "disconnected",
    workspace: null,
    bindings: [],
    deliveries: [],
  };
  fixture.request.mockReset();
  fixture.request.mockImplementation(async (_environmentId: string, action?: LinearAction) => {
    if (action?.type === "enable") settings = { ...settings, enabled: action.enabled };
    if (action?.type === "connect")
      return { settings, authorizeUrl: "https://linear.app/oauth/authorize?fixture=only" };
    if (action?.type === "bind")
      settings = {
        ...settings,
        bindings: [
          {
            id: "issue-one",
            workspaceId: "workspace",
            teamId: "team",
            linearProjectId: "linear-project",
            issueId: "issue-one",
            identifier: "WEA-14",
            title: "Bound issue",
            projectId: action.projectId,
            threadId: action.threadId,
          },
        ],
      };
    if (action?.type === "sync")
      settings = {
        ...settings,
        deliveries: [
          {
            id: "delivery-one",
            bindingId: "issue-one",
            receivedAt: 1,
            outcome: "idle",
            runId: null,
            dispatch: null,
          },
        ],
      };
    if (action?.type === "webhook-secret") settings = { ...settings, webhookConfigured: true };
    if (action?.type === "disconnect")
      settings = {
        ...settings,
        connection: "disconnected",
        workspace: null,
        bindings: [],
        deliveries: [],
      };
    return { settings };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function openPanel() {
  const router = createRouter({
    routeTree: createRootRoute({ component: LinearSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  await vi.waitFor(() => expect(container.textContent).toContain("Linear"));
}

describe("optional Linear settings", () => {
  it("does not choose a host or request settings from all-environment scope", async () => {
    fixture.singleEnvironment = false;
    await openPanel();
    expect(container.textContent).toContain("Select one environment");
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("starts OFF and exposes the real OAuth-registration blocker when enabled", async () => {
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await openPanel();
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(1));
    expect(container.querySelector("[aria-label='Linear issue']")).toBeNull();
    await page.getByRole("switch", { name: "Enable Linear" }).click();
    await vi.waitFor(() => expect(container.textContent).toContain("Setup required"));
    expect(fixture.request).toHaveBeenCalledWith("fixture-env", { type: "enable", enabled: true });
    await expect.element(page.getByRole("button", { name: "Connect Linear" })).toBeDisabled();
    await page.getByRole("button", { name: "Set up Linear" }).click();
    await expect.element(page.getByRole("region", { name: "Linear host setup" })).toBeVisible();
    expect(container.textContent).toContain("T3CODE_LINEAR_CLIENT_ID");
    expect(container.textContent).toContain("T3CODE_LINEAR_REDIRECT_URI");
    expect(container.textContent).toContain("/api/integrations/linear/oauth/callback");
    expect(container.textContent).toContain("Manual Fetch needs OAuth, not a public webhook");
    await page.getByRole("button", { name: "Copy setup checklist" }).click();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    const checklist = copy.mock.calls[0]![0];
    expect(checklist).toContain("T3CODE_LINEAR_CLIENT_ID=<registered-public-client-id>");
    expect(checklist).toContain("T3CODE_LINEAR_REDIRECT_URI=<exact-registered-callback-url>");
    expect(checklist).toContain("your product app owner");
    expect(fixture.request).toHaveBeenCalledTimes(2);
    expect(fixture.request.mock.calls.some((call) => call[1]?.type === "connect")).toBe(false);
    await page.getByRole("button", { name: "Set up Linear" }).click();
    await expect
      .element(page.getByRole("region", { name: "Linear host setup" }))
      .not.toBeInTheDocument();
  });
  it("starts a configured OAuth flow only on Connect", async () => {
    settings = { ...settings, enabled: true, oauthConfigured: true };
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openPanel();
    expect(container.textContent).not.toContain("Set up Linear");
    await page.getByRole("button", { name: "Connect Linear" }).click();
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://linear.app/oauth/authorize?fixture=only",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    await expect
      .element(page.getByRole("link", { name: "Continue in Linear" }))
      .toHaveAttribute("href", "https://linear.app/oauth/authorize?fixture=only");
    expect(fixture.request.mock.calls.filter((call) => call[1]?.type === "connect")).toHaveLength(
      1,
    );
  });
  it.each([false, true])(
    "gates binding on operate and displays held delivery (operate=%s)",
    async (canOperate) => {
      if (!canOperate) fixture.scopes = ["orchestration:read", "settings:write"];
      settings = {
        ...settings,
        enabled: true,
        oauthConfigured: true,
        connection: "connected",
        workspace: { id: "workspace", name: "Fixture workspace", actorId: "app" },
      };
      await openPanel();
      await page.getByRole("textbox", { name: "Linear issue", exact: true }).fill("WEA-14");
      await page.getByRole("combobox", { name: "T3 project" }).click();
      await page.getByRole("option", { name: "Fixture project" }).click();
      await page.getByRole("combobox", { name: "Existing thread" }).click();
      await page.getByRole("option", { name: "Existing owner thread" }).click();
      if (!canOperate) {
        await expect.element(page.getByRole("button", { name: "Bind issue" })).toBeDisabled();
        await expect.element(page.getByRole("button", { name: "Disconnect" })).toBeEnabled();
        expect(fixture.request.mock.calls.some((call) => call[1]?.type === "bind")).toBe(false);
        return;
      }
      await expect.element(page.getByRole("button", { name: "Bind issue" })).toBeEnabled();
      await page.getByRole("button", { name: "Bind issue" }).click();
      await vi.waitFor(() =>
        expect(fixture.request).toHaveBeenCalledWith("fixture-env", {
          type: "bind",
          issueId: "WEA-14",
          projectId: ProjectId.make("fixture-project"),
          threadId: ThreadId.make("fixture-thread"),
        }),
      );
      await page.getByRole("button", { name: "Fetch issue" }).click();
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Waiting for an active thread"),
      );
      expect(container.textContent).not.toContain("Completed");
      await page.getByRole("switch", { name: "Enable Linear" }).click();
      await vi.waitFor(() =>
        expect(container.querySelector("[aria-label='Linear issue']")).toBeNull(),
      );
      expect(fixture.request.mock.calls.filter((call) => call[1]?.type === "sync")).toHaveLength(1);
    },
  );
});
