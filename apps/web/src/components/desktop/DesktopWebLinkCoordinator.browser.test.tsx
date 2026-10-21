import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  connected: ["primary", "24efa85c-862c-4de4-9b5e-aaaa041e28a4"],
  openThread: vi.fn(),
  openScratchProject: vi.fn(),
  openPreview: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: (() => ({
    environmentId: "primary",
    connection: { phase: "connected" },
    serverConfig: {},
  })) as never,
  useConnectedEnvironmentIds: () => mocks.connected.map((id) => EnvironmentId.make(id)),
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock(import("../../hooks/useScratchProject"), () => ({
  useScratchProject: () => ({
    scratchWorkspaceRootFor: () => null,
    scratchEnvironmentId: () => EnvironmentId.make("primary"),
    openScratchProject: mocks.openScratchProject,
    startScratchThread: vi.fn(),
  }),
}));
vi.mock(import("../../hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: () => mocks.openThread,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => mocks.openPreview) as never,
}));
vi.mock(import("../../state/use-atom-query-runner"), () => ({
  useAtomQueryRunner: (() => vi.fn()) as never,
}));
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: mocks.toast } as never,
  stackedThreadToast: ((value: unknown) => value) as never,
}));

import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";
import { useComposerDraftStore } from "../../composerDraftStore";

const environmentId = "24efa85c-862c-4de4-9b5e-aaaa041e28a4";
const threadId =
  "thread:delegated-task:command%3Amcp%3A474c7d68-6293-4de4-9859-011aec7f079b%3Adelegate-task%3At3-iui-rich-components-e2e-20261018-bootstrap-v1";
const encodedLink = `t3code://threads/${environmentId}/${encodeURIComponent(threadId)}`;
const threadRef = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
let history: ReturnType<typeof createHashHistory>;
let listener: ((url: string) => void) | undefined;
let pending: string[];
const setReady = vi.fn(async (ready: boolean) => {
  using _state = setup();
  if (ready) for (const url of pending.splice(0)) listener?.(url);
});

function setup() {
  vi.clearAllMocks();
  mocks.connected = ["primary", environmentId];
  useComposerDraftStore.getState().setPrompt(threadRef, "");
  pending = [];
  listener = undefined;
  vi.stubGlobal("desktopBridge", {
    webLinks: {
      setReady,
      onOpen: (next: typeof listener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  });
  window.history.replaceState(null, "", "/#/primary/current");
  history = createHashHistory();
  return {
    [Symbol.dispose]() {
      history.destroy();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    },
  };
}

async function openApp() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <DesktopWebLinkCoordinator />
        <Outlet />
      </>
    ),
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => <output>{JSON.stringify(threadRoute.useParams())}</output>,
  });
  const newRoute = createRoute({ getParentRoute: () => rootRoute, path: "/new" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute, newRoute]),
    history,
  });
  await router.load();
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
      { router: false }, // This case owns hash history to exercise desktop deep links.
    ),
  );
  await vi.waitFor(() => expect(setReady).toHaveBeenCalledWith(true));
  const owned = stack.move();
  return { router, screen, [Symbol.asyncDispose]: () => owned[Symbol.asyncDispose]() };
}

function expectNoCreation() {
  expect(mocks.openThread).not.toHaveBeenCalled();
  expect(mocks.openScratchProject).not.toHaveBeenCalled();
  expect(mocks.openPreview).not.toHaveBeenCalled();
}

describe("desktop existing thread links", () => {
  it("opens a queued encoded child in its connected remote environment using desktop hash history", async () => {
    using _state = setup();
    pending.push(encodedLink);
    await using app = await openApp();
    const {
      router,
      screen: { container },
    } = app;
    await vi.waitFor(() =>
      expect(container.textContent).toBe(JSON.stringify({ environmentId, threadId })),
    );
    expect(router.state.location.pathname).toBe(
      `/${environmentId}/${encodeURIComponent(threadId)}`,
    );
    expect(window.location.hash).toBe(`#/${environmentId}/${encodeURIComponent(threadId)}`);
    expect(mocks.toast).not.toHaveBeenCalled();
    expectNoCreation();

    await act(async () => listener!("t3code://threads/primary/normal-thread"));
    await vi.waitFor(() =>
      expect(container.textContent).toBe(
        JSON.stringify({ environmentId: "primary", threadId: "normal-thread" }),
      ),
    );
    expectNoCreation();
  });

  it("leaves the current thread in place when the destination environment is not connected", async () => {
    using _state = setup();
    mocks.connected = ["primary"];
    await using app = await openApp();
    const {
      router,
      screen: { container },
    } = app;
    await act(async () => listener!(encodedLink));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe("/primary/current");
    expect(mocks.toast.mock.calls[0]?.[0].description).toContain("Connect to");
    expectNoCreation();
  });

  it.each(['"fix"', "true", "123", '{ "fix": true }', "[1, 2]"])(
    "preserves the raw linked prompt %s through existing-thread navigation",
    async (prompt) => {
      using _state = setup();
      await using app = await openApp();
      const {
        router,
        screen: { container },
      } = app;
      const search = `?prompt=${encodeURIComponent(prompt)}&panel=diff`;
      await act(async () => listener!(`${encodedLink}${search}`));
      await vi.waitFor(() =>
        expect(container.textContent).toBe(JSON.stringify({ environmentId, threadId })),
      );
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(prompt),
      );
      expect(router.state.location.searchStr).toBe("?panel=diff");
      expect(window.location.hash).toBe(
        `#/${environmentId}/${encodeURIComponent(threadId)}?panel=diff`,
      );
      expectNoCreation();
    },
  );

  it("keeps an existing draft until the linked prompt is explicitly accepted", async () => {
    using _state = setup();
    useComposerDraftStore.getState().setPrompt(threadRef, "Keep my draft");
    await using _app = await openApp();
    await act(async () => listener!(`${encodedLink}?prompt=%22fix%22`));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Linked prompt ready" }),
      ),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "Keep my draft",
    );
    expectNoCreation();
  });

  it.each([
    "t3code://threads/primary/%invalid",
    "threads/primary/child",
    "t3code://threads/primary/child/extra",
  ])("does not turn an invalid app destination into a browser tab: %s", async (link) => {
    using _state = setup();
    await using app = await openApp();
    const {
      router,
      screen: { container },
    } = app;
    await act(async () => listener!(link));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe("/primary/current");
    expectNoCreation();
  });

  it("preserves the existing new-prompt path", async () => {
    using _state = setup();
    await using app = await openApp();
    const {
      router,
      screen: { container },
    } = app;
    await act(async () => listener!("t3code://new?prompt=hello"));
    await vi.waitFor(() => expect(router.state.location.href).toBe("/new?prompt=hello"));
    expectNoCreation();
  });

  it("reports failed navigation and keeps receiving subsequent links", async () => {
    using _state = setup();
    await using app = await openApp();
    const {
      router,
      screen: { container },
    } = app;
    vi.spyOn(router, "navigate").mockRejectedValueOnce(new Error("Navigation failed"));
    await act(async () => listener!(encodedLink));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe("/primary/current");
    await act(async () => listener!("t3code://threads/primary/normal-thread"));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/primary/normal-thread"));
    expectNoCreation();
  });
});
