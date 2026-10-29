import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { dispatchKeyboardCommand } from "../keyboard/keyboardCommands";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({
  goBack: vi.fn(async (_tabId: string) => undefined),
  goForward: vi.fn(async (_tabId: string) => undefined),
  refresh: vi.fn(async (_tabId: string) => undefined),
  canGoBack: false,
  canGoForward: false,
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  readEnvironmentScope: vi.fn((_environmentId?: unknown, _scope?: unknown) => true),
  setAnnotationSendEnabled: vi.fn(async (_tabId: string, _enabled: boolean): Promise<void> => {}),
  cancelPickElement: vi.fn(async (_tabId: string) => undefined),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  toast: vi.fn(),
  pictureInPicture: false,
  showEmptyState: false,
  loading: false,
  nativeServerTab: false,
  pageUrl: "http://example.com/",
  serverEpoch: null as string | null,
  servers: [] as PreviewableServer[],
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    refresh: mocks.refresh,
    goBack: mocks.goBack,
    goForward: mocks.goForward,
    hardReload: vi.fn(async () => undefined),
    openDevTools: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  } as never,
}));
vi.mock(import("~/browserHistoryStore"), async (original) => ({
  ...(await original()),
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: mocks.readPreparedConnection as never,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  useThreadPreviewState: (() => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: mocks.canGoBack,
        canGoForward: mocks.canGoForward,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            runtime: mocks.nativeServerTab ? "server" : "desktop",
            navStatus: { _tag: "Success", url: mocks.pageUrl, title: "Example" },
            canGoBack: mocks.canGoBack,
            canGoForward: mocks.canGoForward,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "WSL" })) as never,
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: mocks.toast } };
});
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  useRendersServerTabNatively: () => mocks.nativeServerTab,
}));

vi.mock(import("~/browser/browserViewportActions"), { spy: true });

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { usePreviewSelectionStore } from "~/previewSelectionStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { dispatchPreviewAction } from "./previewActionBus";
import { PreviewView } from "./PreviewView";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

function view(onSendAnnotation?: ComponentProps<typeof PreviewView>["onSendAnnotation"]) {
  return (
    <PreviewView
      threadRef={TEST_THREAD_REF}
      tabId="tab-1"
      visible
      {...(onSendAnnotation ? { onSendAnnotation } : {})}
    />
  );
}

function annotation(id: string, screenshot: unknown = null) {
  return {
    id,
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    comment: "Tighten this spacing",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot,
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
  vi.clearAllMocks();
  usePreviewSelectionStore.setState({ byThreadKey: {} });
  mocks.pageUrl = "http://example.com/";
  mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
  mocks.setAnnotationSendEnabled.mockReset().mockResolvedValue(undefined);
  mocks.pickElement.mockReset();
  mocks.pictureInPicture = false;
  mocks.showEmptyState = false;
  mocks.loading = false;
  mocks.canGoBack = false;
  mocks.canGoForward = false;
  mocks.nativeServerTab = false;
  mocks.serverEpoch = null;
  mocks.servers = [];
  mocks.recordingTabIds = new Set();
  mocks.recordingRuntimeTabId = null;
  useComposerDraftStore.setState({
    addPreviewAnnotation: mocks.addPreviewAnnotation,
    addImage: mocks.addImage,
  });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useBrowserPointerStore.setState({ byTabId: {} });
}

describe("PreviewView", () => {
  it("uses the visible browser for keyboard history, reload and URL focus while respecting history availability", async () => {
    setup();
    await using screen = await render(view());
    expect(dispatchKeyboardCommand("preview.back")).toBe(false);
    expect(mocks.goBack).not.toHaveBeenCalled();
    mocks.canGoBack = true;
    mocks.canGoForward = true;
    await screen.rerender(view());
    await act(async () => {
      dispatchKeyboardCommand("preview.back");
      dispatchKeyboardCommand("preview.forward");
      dispatchKeyboardCommand("preview.refresh");
      dispatchKeyboardCommand("preview.focusUrl");
    });
    expect(mocks.goBack).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    expect(mocks.goForward).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    expect(mocks.refresh).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search or enter URL");
    await screen.rerender(
      <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible={false} />,
    );
    expect(dispatchKeyboardCommand("preview.back")).toBe(false);
  });

  it("keeps browser keyboard commands in the focused browser when two views are visible", async () => {
    setup();
    await using _screen = await render(
      <>
        {view()}
        {view()}
      </>,
    );
    const inputs = [
      ...document.querySelectorAll<HTMLInputElement>('[aria-label="Search or enter URL"]'),
    ];
    expect(inputs).toHaveLength(2);
    await act(async () => inputs[1]!.focus());
    await act(async () => {
      dispatchKeyboardCommand("preview.focusUrl");
    });
    expect(document.activeElement).toBe(inputs[1]);
  });

  it("preserves address editing during IME and restores the displayed URL on Escape", async () => {
    setup();
    await using _screen = await render(view());
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search or enter URL"]')!;
    await act(async () => input.focus());
    await userEvent.fill(
      page.getByRole("textbox", { name: "Search or enter URL" }),
      "https://new.example/",
    );
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(input);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("http://example.com/");
  });

  it("retains comment-free selection for Voice and sends feedback without staging a draft", async () => {
    setup();
    const onSendAnnotation = vi.fn();
    await using _screen = await render(view(onSendAnnotation));
    const selected = { ...annotation("selected"), comment: "", screenshot: null };
    await act(async () =>
      usePreviewSelectionStore.getState().replaceSelection(TEST_THREAD_REF, selected),
    );
    await expect.element(page.getByRole("textbox", { name: "Selection feedback" })).toBeVisible();
    expect(
      usePreviewSelectionStore.getState().byThreadKey[scopedThreadKey(TEST_THREAD_REF)]?.comment,
    ).toBe("");
    await userEvent.fill(
      page.getByRole("textbox", { name: "Selection feedback" }),
      "Make this blue",
    );
    await userEvent.click(page.getByRole("button", { name: "Send", exact: true }));
    await vi.waitFor(() =>
      expect(onSendAnnotation).toHaveBeenCalledWith(
        { ...selected, comment: "Make this blue" },
        null,
      ),
    );
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
  });

  it("clears selection on URL changes, tab changes and closing, without accepting an old picker result", async () => {
    setup();
    let finishPick: ((result: unknown) => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPick = resolve;
        }),
    );
    await using screen = await render(view());
    await userEvent.click(page.getByRole("button", { name: "Annotate preview", exact: true }));
    await vi.waitFor(() => expect(finishPick).toBeDefined());
    const key = scopedThreadKey(TEST_THREAD_REF);
    const selected = { ...annotation("before-navigation"), comment: "", screenshot: null };
    await act(async () =>
      usePreviewSelectionStore.getState().replaceSelection(TEST_THREAD_REF, selected),
    );
    mocks.pageUrl = "http://example.com/next";
    await screen.rerender(view());
    expect(usePreviewSelectionStore.getState().byThreadKey[key]).toBeUndefined();
    const current = { ...selected, id: "current", pageUrl: mocks.pageUrl };
    await act(async () =>
      usePreviewSelectionStore.getState().replaceSelection(TEST_THREAD_REF, current),
    );
    await act(async () => finishPick?.({ annotation: selected, submission: "attach" }));
    expect(usePreviewSelectionStore.getState().byThreadKey[key]?.id).toBe("current");
    await screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-2" visible />);
    expect(usePreviewSelectionStore.getState().byThreadKey[key]).toBeUndefined();
    await act(async () =>
      usePreviewSelectionStore
        .getState()
        .replaceSelection(TEST_THREAD_REF, { ...current, id: "second-tab" }),
    );
    await screen.rerender(<div />);
    expect(usePreviewSelectionStore.getState().byThreadKey[key]).toBeUndefined();
  });

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    setup();
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await using screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await screen.rerender(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await screen.rerender(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    setup();
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await using _screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    expect(mocks.addImage).not.toHaveBeenCalled();
  });

  it("focuses the address bar each time the focus-url shortcut fires", async () => {
    setup();
    await using _screen = await render(view());
    const address = page.getByRole("textbox");

    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();

    (address.element() as HTMLInputElement).blur();
    await expect.element(address).not.toHaveFocus();
    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();
  });
});
