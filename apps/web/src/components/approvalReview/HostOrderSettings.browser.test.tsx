import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { __resetClientSettingsPersistenceForTests } from "../../hooks/useSettings";
import { approvalOrderEnvironment } from "../../state/approvalOrders";
import { ConfiguredHostOrderChatMode } from "./HostOrderChatMode";
import { useHostOrderComposerStore } from "./HostOrderComposerStore";
import { HostOrderSettings } from "./HostOrderSettings";
import "../../index.css";

const fixture = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), connected: true }));
vi.mock("../../localApi", async (original) => ({
  ...(await original<typeof import("../../localApi")>()),
  ensureLocalApi: () => ({
    persistence: { getClientSettings: fixture.get, setClientSettings: fixture.save },
  }),
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    isReady: true,
    environments: [
      {
        environmentId: "host",
        label: "Control host",
        connection: { phase: fixture.connected ? "connected" : "offline" },
      },
    ],
  }),
}));
vi.mock("../../state/approvalOrders", () => {
  const command = () => ({ label: "test-order", run: vi.fn(), permissionAtom: vi.fn() });
  return {
    approvalOrderEnvironment: {
      create: command(),
      read: command(),
      cancel: command(),
      readiness: command(),
    },
  };
});

function setup(enabled = false) {
  __resetClientSettingsPersistenceForTests();
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  fixture.connected = true;
  fixture.get.mockReset().mockResolvedValue({ hostOrderEntryEnabled: enabled });
  fixture.save.mockReset().mockResolvedValue(undefined);
  for (const command of Object.values(approvalOrderEnvironment)) {
    vi.mocked(command.run).mockReset();
    vi.mocked(command.permissionAtom).mockReset().mockReturnValue(Atom.make(true));
  }
  vi.mocked(approvalOrderEnvironment.readiness.run).mockResolvedValue(
    AsyncResult.success({
      enabled: false,
      reason: "feature-disabled",
      configured: true,
      channels: [],
    }),
  );
}

it("loads saved visibility without provisioning policy or querying a host", async () => {
  setup();
  await using screen = await render(<HostOrderSettings />);
  await expect.element(screen.getByRole("switch", { name: "Show protected tasks" })).toBeEnabled();
  await expect
    .element(screen.getByRole("switch", { name: "Show protected tasks" }))
    .not.toBeChecked();
  expect(approvalOrderEnvironment.readiness.run).not.toHaveBeenCalled();
  await screen.getByRole("switch", { name: "Show protected tasks" }).click();
  await expect.element(screen.getByRole("switch", { name: "Show protected tasks" })).toBeChecked();
  expect(fixture.save).toHaveBeenCalledWith(
    expect.objectContaining({ hostOrderEntryEnabled: true }),
  );
  expect(approvalOrderEnvironment.readiness.run).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Check host setup" }).click();
  await expect.element(screen.getByText("Configured · disabled by host operator")).toBeVisible();
  expect(approvalOrderEnvironment.create.run).not.toHaveBeenCalled();
  expect(approvalOrderEnvironment.cancel.run).not.toHaveBeenCalled();
});

it("stays closed during hydration and after a saved-settings read failure", async () => {
  setup();
  let fail!: (reason: Error) => void;
  fixture.get.mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  await using screen = await render(<HostOrderSettings />);
  await expect.element(screen.getByRole("switch", { name: "Show protected tasks" })).toBeDisabled();
  await act(async () => fail(new Error("Saved settings unavailable")));
  await expect
    .element(screen.getByRole("switch", { name: "Show protected tasks" }))
    .not.toBeChecked();
  await expect.element(screen.getByRole("switch", { name: "Show protected tasks" })).toBeDisabled();
  expect(fixture.save).not.toHaveBeenCalled();
  expect(approvalOrderEnvironment.readiness.run).not.toHaveBeenCalled();
});

it.each(["offline", "permission"] as const)(
  "distinguishes %s from unconfigured host protection",
  async (reason) => {
    setup(true);
    if (reason === "offline") fixture.connected = false;
    else
      vi.mocked(approvalOrderEnvironment.readiness.permissionAtom).mockReturnValue(
        Atom.make(false),
      );
    await using screen = await render(<HostOrderSettings />);
    await expect
      .element(
        screen.getByText(
          reason === "offline" ? "Offline" : "Missing permission to check host setup",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Check host setup" })).toBeDisabled();
    expect(approvalOrderEnvironment.readiness.run).not.toHaveBeenCalled();
  },
);

it("retains a protected draft and unknown request through real Setup navigation and opt-out", async () => {
  setup(true);
  const destination = {
    environmentId: EnvironmentId.make("vm"),
    threadId: ThreadId.make("vm-conversation"),
  };
  vi.mocked(approvalOrderEnvironment.readiness.run).mockResolvedValue(
    AsyncResult.success({
      enabled: true,
      reason: "ready",
      sourceKind: "synthetic",
      testOnly: true,
      channels: [
        {
          hostThreadId: ThreadId.make("host-control"),
          vmId: "vm",
          label: "Work VM",
          environmentId: destination.environmentId,
          threadId: destination.threadId,
          ready: true,
          reason: "ready",
        },
      ],
    }),
  );
  vi.mocked(approvalOrderEnvironment.create.run).mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(
        new EnvironmentRpcUnavailableError({
          environmentId: EnvironmentId.make("host"),
          message: "Lost send response",
        }),
      ),
    ),
  );
  const root = createRootRoute({ component: Outlet });
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: () => (
      <>
        <Link to="/settings/integrations">Settings</Link>
        <ConfiguredHostOrderChatMode
          hosts={[
            { environmentId: EnvironmentId.make("host"), label: "Control host", connected: true },
          ]}
          destination={destination}
        >
          <p>Normal conversation</p>
        </ConfiguredHostOrderChatMode>
      </>
    ),
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings/integrations",
    component: () => (
      <>
        <HostOrderSettings />
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: destination.environmentId, threadId: destination.threadId }}
        >
          Return to chat
        </Link>
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([chat, settings]),
    history: createMemoryHistory({ initialEntries: ["/vm/vm-conversation"] }),
  });
  await router.load();
  // Own the real chat/settings routes to exercise their unmount and return lifecycle.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await screen.getByRole("combobox", { name: "Protecting host" }).click();
  await page.getByRole("option", { name: "Control host", exact: true }).click();
  await expect.element(screen.getByText("VM: Work VM")).toBeVisible();
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Task" }),
    "  Exact unsent or unknown draft  ",
  );
  await screen.getByRole("button", { name: "Send synthetic task" }).click();
  await expect.element(screen.getByText("Send outcome unknown", { exact: true })).toBeVisible();
  const original = vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1];
  await screen.getByRole("link", { name: "Setup", exact: true }).click();
  await expect.element(screen.getByRole("switch", { name: "Show protected tasks" })).toBeChecked();
  await screen.getByRole("switch", { name: "Show protected tasks" }).click();
  await expect
    .element(screen.getByRole("switch", { name: "Show protected tasks" }))
    .not.toBeChecked();
  await screen.getByRole("link", { name: "Return to chat" }).click();
  expect(
    screen.getByRole("button", { name: "Protected task", exact: true }).elements(),
  ).toHaveLength(0);
  await screen.getByRole("link", { name: "Settings", exact: true }).click();
  await screen.getByRole("switch", { name: "Show protected tasks" }).click();
  await expect.element(screen.getByRole("switch", { name: "Show protected tasks" })).toBeChecked();
  await screen.getByRole("link", { name: "Return to chat" }).click();
  await screen.getByRole("button", { name: "Protected task", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Task" }))
    .toHaveValue("  Exact unsent or unknown draft  ");
  await expect.element(screen.getByText("Send outcome unknown", { exact: true })).toBeVisible();
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("button", { name: "Retry same send" })).toBeEnabled();
  await screen.getByRole("button", { name: "Retry same send" }).click();
  expect(vi.mocked(approvalOrderEnvironment.create.run).mock.calls[1]![1]).toEqual(original);
});
