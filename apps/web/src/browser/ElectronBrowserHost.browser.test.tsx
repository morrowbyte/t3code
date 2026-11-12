import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  ensureOffscreenHost: vi.fn<DesktopPreviewBridge["ensureOffscreenHost"]>(),
  getHostedEnvironmentIds: vi.fn<DesktopPreviewBridge["getHostedEnvironmentIds"]>(),
  onHostedEnvironmentsChange: vi.fn<DesktopPreviewBridge["onHostedEnvironmentsChange"]>(),
  primaryEnvironmentId: null as EnvironmentId | null,
  discoveryBindings: new Map<symbol, EnvironmentId>(),
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(() => mocks.primaryEnvironmentId) };
});

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
    ensureOffscreenHost: mocks.ensureOffscreenHost,
    getHostedEnvironmentIds: mocks.getHostedEnvironmentIds,
    onHostedEnvironmentsChange: mocks.onHostedEnvironmentsChange,
  } as never,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

vi.mock(import("~/components/preview/usePreviewSession"), async (original) => {
  const actual = await original();
  const { useEffect } = await import("react");
  return {
    ...actual,
    useDesktopHostedPreviewSessions: vi.fn(function useDesktopHostedPreviewSessions(
      environmentId: EnvironmentId | null,
    ) {
      actual.useDesktopHostedPreviewSessions(environmentId);
      // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks each real discovery hook binding through mount and cleanup
      useEffect(() => {
        if (environmentId === null) return;
        const binding = Symbol(environmentId);
        mocks.discoveryBindings.set(binding, environmentId);
        return () => {
          mocks.discoveryBindings.delete(binding);
        };
      }, [environmentId]);
    }),
  };
});

import { useDesktopHostedPreviewSessions } from "~/components/preview/usePreviewSession";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { subscribeDesktopBrowserHostedEnvironments } from "./desktopBrowserSurface";
import { rendersServerTabNatively, useControlsNativePreviewTab } from "./previewRuntime";

const threadRef = scopeThreadRef(
  EnvironmentId.make("host-webview-order"),
  ThreadId.make("thread-webview-order"),
);

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

function setup(): Disposable {
  vi.mocked(useDesktopHostedPreviewSessions).mockClear();
  mocks.discoveryBindings.clear();
  mocks.primaryEnvironmentId = null;
  appAtomRegistry.refresh(primaryEnvironmentIdAtom);
  __resetClientSettingsPersistenceForTests();
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getHostedEnvironmentIds.mockReset().mockResolvedValue([]);
  mocks.onHostedEnvironmentsChange.mockReset().mockReturnValue(() => {});
  mocks.ensureOffscreenHost.mockReset().mockResolvedValue({
    kind: "webview",
    webContentsId: 7,
    privateEntry: false,
  });
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-default",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  return {
    [Symbol.dispose]() {
      resetPreviewStateForTests();
      __resetClientSettingsPersistenceForTests();
    },
  };
}

async function renderHost(element = <ElectronBrowserHost />) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(<AppAtomRegistryProvider>{element}</AppAtomRegistryProvider>),
  );
  // Unmounting releases each tab on a close timer; run it now so it never fires in a later test.
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(() => ensureClientSettingsHydrated());
  const environment = stack.move();
  return { container: screen.container, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

describe("ElectronBrowserHost", () => {
  it("keeps Main-confirmed remote guests through reconnect without replacing legacy guests", async () => {
    using _state = setup();
    const primaryEnvironmentId = EnvironmentId.make("focused-primary-host");
    const otherRemoteEnvironmentId = EnvironmentId.make("other-background-host");
    mocks.primaryEnvironmentId = primaryEnvironmentId;
    appAtomRegistry.refresh(primaryEnvironmentIdAtom);
    let resolveQuery: ((ids: ReadonlyArray<string>) => void) | undefined;
    mocks.getHostedEnvironmentIds.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    mocks.ensureOffscreenHost.mockResolvedValue({
      kind: "offscreen",
      webContentsId: 8,
      privateEntry: false,
    });
    const native = {
      ...snapshot("remote-native", "2026-01-01T00:00:01.000Z"),
      runtime: "server" as const,
    };
    const headless = { ...native, tabId: "remote-headless", headless: true };
    function NativeControlState() {
      const desktop = useControlsNativePreviewTab(threadRef.environmentId, { runtime: "desktop" });
      const server = useControlsNativePreviewTab(threadRef.environmentId, native);
      const hidden = useControlsNativePreviewTab(threadRef.environmentId, {
        runtime: "desktop",
        headless: true,
      });
      const unknown = useControlsNativePreviewTab(EnvironmentId.make("unknown"), native);
      return <output data-native-controls={[desktop, server, hidden, unknown].join(",")} />;
    }
    reconcilePreviewServerSessions(threadRef, {
      sessions: [snapshot("legacy", "2026-01-01T00:00:01.000Z"), native, headless],
      serverEpoch: "remote-epoch",
      revision: 1,
    });
    await using screen = await renderHost(
      <>
        <ElectronBrowserHost />
        <NativeControlState />
      </>,
    );
    await vi.waitFor(() => expect(screen.container.querySelectorAll("webview")).toHaveLength(1));
    const legacy = screen.container.querySelector("webview")!;
    legacy.getWebContentsId = () => 7;
    const controlState = () =>
      screen.container
        .querySelector("[data-native-controls]")
        ?.getAttribute("data-native-controls");
    const legacyRuntimeTabId = mocks.createTab.mock.calls[0]![0];
    expect(rendersServerTabNatively(threadRef.environmentId, null, native)).toBe(false);
    expect(mocks.ensureOffscreenHost).not.toHaveBeenCalled();
    expect(controlState()).toBe("false,false,false,false");
    const discovery = vi.mocked(useDesktopHostedPreviewSessions);
    expect(discovery).toHaveBeenCalledWith(primaryEnvironmentId);
    expect(discovery).not.toHaveBeenCalledWith(threadRef.environmentId);
    expect(discovery).not.toHaveBeenCalledWith(otherRemoteEnvironmentId);
    expect([...mocks.discoveryBindings.values()]).toEqual([primaryEnvironmentId]);
    discovery.mockClear();

    const changed = mocks.onHostedEnvironmentsChange.mock.calls[0]![0];
    await act(() =>
      changed([
        primaryEnvironmentId,
        threadRef.environmentId,
        threadRef.environmentId,
        otherRemoteEnvironmentId,
      ]),
    );
    const expectKnownDiscovery = () => {
      expect(discovery).toHaveBeenCalledWith(primaryEnvironmentId);
      expect(discovery).toHaveBeenCalledWith(threadRef.environmentId);
      expect(discovery).toHaveBeenCalledWith(otherRemoteEnvironmentId);
      expect([...mocks.discoveryBindings.values()].sort()).toEqual(
        [primaryEnvironmentId, threadRef.environmentId, otherRemoteEnvironmentId].sort(),
      );
      expect(discovery).not.toHaveBeenCalledWith(EnvironmentId.make("unknown"));
    };
    expectKnownDiscovery();
    const initialDiscoveryBindings = new Map(mocks.discoveryBindings);
    await vi.waitFor(() => expect(mocks.ensureOffscreenHost).toHaveBeenCalledTimes(2));
    const initialHostConnections = mocks.ensureOffscreenHost.mock.calls.length;
    const nativeRuntimeTabId = mocks.ensureOffscreenHost.mock.calls[0]![0].tabId;
    await vi.waitFor(() =>
      expect(mocks.createTab).toHaveBeenCalledWith(legacyRuntimeTabId, {
        serverTab: {
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          tabId: "legacy",
        },
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.registerWebview).toHaveBeenCalledWith(legacyRuntimeTabId, 7),
    );
    expect(controlState()).toBe("true,true,false,false");
    expect(mocks.createTab).toHaveBeenCalledWith(
      nativeRuntimeTabId,
      expect.objectContaining({
        initialUrl: "https://example.com/remote-native",
        serverTab: {
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          tabId: native.tabId,
        },
      }),
    );
    expect(rendersServerTabNatively(threadRef.environmentId, null, native)).toBe(true);
    expect(rendersServerTabNatively(threadRef.environmentId, null, headless)).toBe(false);
    expect(
      rendersServerTabNatively(threadRef.environmentId, threadRef.environmentId, headless),
    ).toBe(false);
    expect(rendersServerTabNatively(EnvironmentId.make("unknown"), null, native)).toBe(false);
    expect(screen.container.querySelector("webview")).toBe(legacy);

    await act(() => resolveQuery?.([]));
    expect(rendersServerTabNatively(threadRef.environmentId, null, native)).toBe(true);
    await act(() => changed([]));
    expect(rendersServerTabNatively(threadRef.environmentId, null, native)).toBe(true);
    await act(() => changed([threadRef.environmentId]));
    expectKnownDiscovery();
    expect(mocks.discoveryBindings).toEqual(initialDiscoveryBindings);
    expect(screen.container.querySelector("webview")).toBe(legacy);
    expect(mocks.ensureOffscreenHost).toHaveBeenCalledTimes(initialHostConnections);
    expect(mocks.createTab).toHaveBeenCalledTimes(3);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(controlState()).toBe("true,true,false,false");

    using _timers = fakeTimers();
    await act(() => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [snapshot("legacy", "2026-01-01T00:00:01.000Z"), headless],
        serverEpoch: "remote-epoch",
        revision: 2,
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith(nativeRuntimeTabId);
    expect(screen.container.querySelector("webview")).toBe(legacy);
  });

  it("clears known remote hosts on scope release and ignores its late query and events", async () => {
    using _state = setup();
    let resolveOldQuery: ((ids: ReadonlyArray<string>) => void) | undefined;
    const oldQuery = new Promise<ReadonlyArray<string>>((resolve) => {
      resolveOldQuery = resolve;
    });
    mocks.getHostedEnvironmentIds.mockReturnValueOnce(oldQuery);
    const releaseOld = subscribeDesktopBrowserHostedEnvironments(mocks);
    const oldChanged = mocks.onHostedEnvironmentsChange.mock.calls[0]![0];
    const native = { runtime: "server" as const };
    oldChanged([threadRef.environmentId]);
    expect(rendersServerTabNatively(threadRef.environmentId, null, native)).toBe(true);
    releaseOld();
    expect(rendersServerTabNatively(threadRef.environmentId, null, native)).toBe(false);

    const otherEnvironmentId = EnvironmentId.make("another-host");
    mocks.getHostedEnvironmentIds.mockResolvedValueOnce([otherEnvironmentId]);
    using _connection = {
      [Symbol.dispose]: subscribeDesktopBrowserHostedEnvironments(mocks),
    };
    resolveOldQuery?.([threadRef.environmentId]);
    await oldQuery;
    oldChanged([threadRef.environmentId]);
    expect(rendersServerTabNatively(threadRef.environmentId, null, native)).toBe(false);
    expect(rendersServerTabNatively(otherEnvironmentId, null, native)).toBe(true);
  });

  it.each([
    { serverDriven: false, primary: true },
    { serverDriven: true, primary: true },
    { serverDriven: false, primary: false },
  ])(
    "creates OSR only with the tab's native control binding: %j",
    async ({ serverDriven, primary }) => {
      using _state = setup();
      mocks.primaryEnvironmentId = primary ? threadRef.environmentId : null;
      appAtomRegistry.refresh(primaryEnvironmentIdAtom);
      let created: (() => void) | undefined;
      mocks.createTab.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            created = resolve;
          }),
      );
      mocks.ensureOffscreenHost.mockResolvedValue({
        kind: "offscreen",
        webContentsId: 8,
        privateEntry: false,
      });
      await using screen = await renderHost(
        <HostedBrowserWebview
          threadRef={threadRef}
          tabId="offscreen"
          runtimeTabId="offscreen"
          initialUrl="https://example.com/owned"
          viewport={{ _tag: "freeform", width: 1440, height: 1700 }}
          pictureInPicture={false}
          profileId="default"
          zoomFactor={1}
          serverDriven={serverDriven}
        />,
      );
      expect(Boolean(screen.container.querySelector("webview"))).toBe(!primary);
      expect(mocks.ensureOffscreenHost).not.toHaveBeenCalled();
      await act(() => created?.());
      if (!primary) {
        expect(mocks.ensureOffscreenHost).not.toHaveBeenCalled();
        expect(screen.container.querySelector("webview")?.getAttribute("src")).toBe(
          "https://example.com/owned",
        );
        return;
      }
      await vi.waitFor(() =>
        expect(mocks.ensureOffscreenHost).toHaveBeenCalledWith({
          tabId: "offscreen",
          environmentId: threadRef.environmentId,
          profileId: "default",
          viewport: { _tag: "freeform", width: 1440, height: 1700 },
        }),
      );
      expect(screen.container.querySelector("webview")).toBeNull();
      expect(mocks.registerWebview).not.toHaveBeenCalled();
      expect(mocks.createTab).toHaveBeenCalledWith(
        "offscreen",
        expect.objectContaining({
          serverTab: { threadId: threadRef.threadId, tabId: "offscreen" },
        }),
      );
    },
  );

  it.each([
    { serverDriven: true, automationOwned: true, paintable: true },
    { serverDriven: true, automationOwned: false, paintable: false },
    { serverDriven: false, automationOwned: true, paintable: false },
  ])("keeps only hidden agent-created server guests paintable: %j", async (input) => {
    using _state = setup();
    await using screen = await renderHost(
      <HostedBrowserWebview
        threadRef={threadRef}
        tabId="agent-paintability"
        runtimeTabId="agent-paintability"
        initialUrl="https://example.com/owned"
        viewport={{ _tag: "fill" }}
        pictureInPicture={false}
        profileId={undefined}
        zoomFactor={1}
        serverDriven={input.serverDriven}
        automationOwned={input.automationOwned}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-preview-rendering]")).not.toBeNull(),
    );
    const wrapper = screen.container.querySelector<HTMLElement>("[data-preview-rendering]")!;
    expect(wrapper).not.toBeNull();
    expect(wrapper.dataset.previewRendering).toBe(input.paintable ? "active" : "suspended");
    expect(wrapper.style.left).toBe(input.paintable ? "0px" : "-100000px");
    expect(wrapper.style.pointerEvents).toBe("none");
    expect(wrapper.style.zIndex).toBe("-1");
    expect(wrapper.querySelector("webview")?.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.querySelector("webview")?.getAttribute("webpreferences")).toBe(
      input.paintable ? "contextIsolation=yes,backgroundThrottling=false" : "contextIsolation=yes",
    );
  });

  it("never moves a tab's webview when the server reorders tabs by last update", async () => {
    using _state = setup();
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using screen = await renderHost();

    const host = screen.container.querySelector("[data-electron-browser-host]")!;
    const webviews = () => [...host.querySelectorAll("webview")];
    await vi.waitFor(() => expect(webviews()).toHaveLength(2));
    const before = webviews();
    expect(before.map((node) => node.getAttribute("data-preview-server-tab")).toSorted()).toEqual([
      "tab_7",
      "tab_8",
    ]);

    // Electron destroys a webview's guest when its element leaves the DOM, so a reorder that
    // detaches and re-inserts the element blanks the tab.
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true, subtree: true });

    await act(async () => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });
    observer.takeRecords().forEach((record) => detached.push(...record.removedNodes));
    observer.disconnect();

    expect(detached).toEqual([]);
    const after = webviews();
    expect(after).toHaveLength(2);
    expect(after.every((node, index) => node.isSameNode(before[index]!))).toBe(true);
  });
});
