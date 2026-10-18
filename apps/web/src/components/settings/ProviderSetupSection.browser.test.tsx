import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
  type ServerSettingsPatch,
  ProviderInstanceConfig,
} from "@t3tools/contracts";
import { act } from "react";
import * as Schema from "effect/Schema";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  authState: vi.fn(() => "auth"),
  installState: vi.fn(() => "installation"),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  respondAuth: vi.fn(),
  cancelAuth: vi.fn(),
  logoutAuth: vi.fn(),
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  removeInstall: vi.fn(),
  refreshProviders: vi.fn(),
  confirm: vi.fn(),
  openExternal: vi.fn(),
  updateSettings:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: { patch: ServerSettingsPatch };
      }) => Promise<{ _tag: "Success"; value: undefined }>
    >(),
  publishProviders: vi.fn<(providers: ReadonlyArray<ServerProvider>) => void>(),
  canManage: true,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("../../rpc/atomRegistry");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]);
  setup.publishProviders.mockImplementation((value) => appAtomRegistry.set(providers, value));
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: () => providers,
      updateSettings: setup.updateSettings as never,
      providerAuthState: setup.authState as never,
      providerInstallState: setup.installState as never,
      startProviderAuth: setup.startAuth as never,
      completeProviderAuth: setup.completeAuth as never,
      respondProviderAuth: setup.respondAuth as never,
      cancelProviderAuth: setup.cancelAuth as never,
      logoutProviderAuth: setup.logoutAuth as never,
      startProviderInstall: setup.startInstall as never,
      cancelProviderInstall: setup.cancelInstall as never,
      removeProviderInstallation: setup.removeInstall as never,
      refreshProviders: setup.refreshProviders as never,
    },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => setup.canManage,
  readEnvironmentScope: () => setup.canManage,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const { DEFAULT_UNIFIED_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    ...(await original()),
    useEnvironmentSettings: <T = typeof DEFAULT_UNIFIED_SETTINGS,>(
      _environmentId: EnvironmentId,
      selector?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => T,
    ): T => (selector ? selector(DEFAULT_UNIFIED_SETTINGS) : (DEFAULT_UNIFIED_SETTINGS as T)),
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
// The queries behave like live subscriptions: changing `setup.auth` and calling
// `publish()` re-renders the sections that read them.
const queryListeners = vi.hoisted(() => new Set<() => void>());
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    queryListeners.add(listener);
    return () => queryListeners.delete(listener);
  };
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: string) => ({
      data: useSyncExternalStore(subscribe, () =>
        atom === "auth" ? setup.auth : setup.installation,
      ),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    })) as never,
  };
});
const publish = () =>
  act(async () => {
    for (const listener of queryListeners) listener();
  });
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () =>
    ({ dialogs: { confirm: setup.confirm }, shell: { openExternal: setup.openExternal } }) as never,
}));

import { ProviderSetupSection } from "./ProviderSetupSection";
import { CodexSetupSection, AddManagedCodexAccountDialog } from "./CodexSetupSection";
import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const decodeProviderInstance = Schema.decodeUnknownSync(ProviderInstanceConfig);
const environmentId = EnvironmentId.make("remote-google");
const instanceId = ProviderInstanceId.make("antigravity_work");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  installed: true,
  enabled: true,
  version: "test-version",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: true },
};

function authState(patch: Partial<ProviderAuthState> = {}): ProviderAuthState {
  return {
    instanceId,
    phase: "waiting",
    flowId: "flow-1",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-only",
    expiresAt: "2026-09-02T00:05:00.000Z",
    message: null,
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

function renderSetup(
  options: {
    readOnly?: boolean;
    provider?: ServerProvider;
    enabled?: boolean;
    binaryPath?: string;
  } = {},
) {
  return act(async () =>
    root.render(
      <ProviderSetupSection
        environmentId={environmentId}
        environmentLabel="Remote Google device"
        instanceId={instanceId}
        provider={options.provider ?? provider}
        binaryPath={options.binaryPath}
        enabled={options.enabled ?? true}
        readOnly={options.readOnly ?? false}
        onEnable={vi.fn()}
      />,
    ),
  );
}

function button(label: string) {
  return (
    [...container.querySelectorAll("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    ) ?? null
  );
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).not.toBeNull();
  expect(target!.disabled, `${label} disabled`).toBe(false);
  await act(async () => target!.click());
}
function occurrences(text: string) {
  return (container.textContent ?? "").split(text).length - 1;
}
const callbackInput = () =>
  container.querySelector<HTMLInputElement>(`[id="provider-callback-${instanceId}"]`)!;

describe("Antigravity setup", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    setup.canManage = true;
    setup.publishProviders([]);
    setup.updateSettings.mockResolvedValue({ _tag: "Success", value: undefined });
    setup.auth = authState();
    setup.installation = {
      driver: ProviderDriverKind.make("antigravity"),
      operationId: null,
      phase: "idle",
      downloadedBytes: 0,
      totalBytes: null,
      version: null,
      installedVersion: null,
      canRemove: false,
      message: null,
    };
    for (const command of [
      setup.startAuth,
      setup.completeAuth,
      setup.cancelAuth,
      setup.logoutAuth,
      setup.startInstall,
      setup.cancelInstall,
      setup.removeInstall,
    ]) {
      command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    }
    setup.confirm.mockReset().mockResolvedValue(false);
    setup.openExternal.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    await renderSetup();
    await act(async () => userEvent.fill(callbackInput(), callbackUrl));
    await click("Continue");

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    expect(occurrences("Signed in.")).toBe(0);
    expect(callbackInput().value).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    await publish();
    expect(occurrences("Signed in.")).toBe(0);
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    await renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    expect(occurrences("Signed in.")).toBe(1);
  });

  it("offers sign-in again when credentials expire after a completed auth flow", async () => {
    setup.auth = authState({
      phase: "succeeded",
      authorizationUrl: null,
      message: "Google sign-in complete.",
    });
    await renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    await renderSetup();
    expect(button("Sign in")).not.toBeNull();
    expect(occurrences("Signed in.")).toBe(0);
    expect(occurrences("Google sign-in complete.")).toBe(0);
  });

  it("does not send a callback left over from a replaced sign-in flow", async () => {
    const interaction = {
      type: "browser" as const,
      id: "same-interaction",
      url: "https://example.com/login",
      requiresConsent: false,
      acceptsCallback: true,
    };
    setup.auth = authState({ interaction });
    await renderSetup();
    await act(async () =>
      userEvent.fill(callbackInput(), "http://127.0.0.1:5555/?state=old-flow&code=test-only"),
    );
    setup.auth = authState({ flowId: "flow-2", interaction });
    await publish();
    expect(callbackInput().value).toBe("");
    await act(async () => callbackInput().form!.requestSubmit());

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("coalesces repeated sign-in clicks while start is pending", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    const pending = deferred<{ _tag: "Success"; value: undefined }>();
    setup.startAuth.mockReturnValueOnce(pending.promise);
    await renderSetup();
    const signIn = button("Sign in")!;
    // Both clicks land before React re-renders the button as disabled.
    await act(async () => {
      signIn.click();
      signIn.click();
    });

    expect(setup.startAuth).toHaveBeenCalledTimes(1);
    expect(setup.startAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    await act(async () => pending.resolve({ _tag: "Success", value: undefined }));
  });

  it("shows a repeated runtime status message only once", async () => {
    setup.installation = {
      ...setup.installation!,
      operationId: "install-1",
      phase: "verifying",
      message: "Checking the downloaded runtime.",
    };

    await renderSetup();
    expect(occurrences("Checking the downloaded runtime.")).toBe(1);
  });

  it("removes an owned damaged runtime only after confirmation", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      phase: "failed",
      canRemove: true,
      installedVersion: null,
    };
    await renderSetup();
    await click("Remove downloaded runtime");
    expect(setup.confirm).toHaveBeenCalledOnce();
    expect(setup.removeInstall).not.toHaveBeenCalled();

    setup.confirm.mockResolvedValue(true);
    await click("Remove downloaded runtime");
    expect(setup.removeInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });

  it.each([true, false])(
    "can sign out a verified account when its instance is enabled=%s",
    async (enabled) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      setup.confirm.mockResolvedValue(true);
      await renderSetup({
        enabled,
        provider: {
          ...provider,
          enabled,
          installed: false,
          status: enabled ? "warning" : "disabled",
          auth: { status: "authenticated" },
        },
      });
      await click("Sign out");
      expect(setup.logoutAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    },
  );

  it.each(["unauthenticated", "unknown"] as const)(
    "does not offer sign-out for an unverified %s account",
    async (status) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      await renderSetup({
        provider: { ...provider, auth: { status, canLogout: true } },
      });
      expect(button("Sign in")).not.toBeNull();
      expect(button("Sign out")).toBeNull();
      expect(button("Change account")).toBeNull();
    },
  );

  it("offers account actions after verified login when discovery cannot identify auth", async () => {
    setup.auth = authState({ phase: "succeeded", flowId: null, authorizationUrl: null });
    await renderSetup({ provider: { ...provider, auth: { status: "unknown" } } });
    expect(button("Change account")).not.toBeNull();
    expect(button("Sign out")).not.toBeNull();
    expect(button("Sign in")).toBeNull();
  });

  it("does not let a shared managed install hide an invalid custom binary path", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    await renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(button("Sign in")?.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });

  it.each(["read-only", "older-server"] as const)(
    "does not open private setup subscriptions for a %s view",
    async (mode) => {
      const { setup: _setup, ...olderProvider } = provider;
      await renderSetup(mode === "read-only" ? { readOnly: true } : { provider: olderProvider });
      expect(setup.authState).not.toHaveBeenCalled();
      expect(setup.installState).not.toHaveBeenCalled();
      expect(setup.startAuth).not.toHaveBeenCalled();
    },
  );

  it("installs native Codex before offering explicit sign-in to the same instance", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.refreshProviders.mockResolvedValue({ _tag: "Success", value: undefined });
    const nativeProvider: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("codex"),
      installed: false,
      auth: { status: "unauthenticated" },
    };
    await act(async () =>
      root.render(
        <CodexSetupSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={nativeProvider}
          mode="existing"
          enabled
          onModeChange={vi.fn()}
        />,
      ),
    );
    expect(button("Install Codex")).not.toBeNull();
    expect(button("Sign in")).toBeNull();
    expect(setup.startInstall).not.toHaveBeenCalled();
    expect(setup.startAuth).not.toHaveBeenCalled();
    await click("Install Codex");
    expect(setup.startInstall).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId },
    });
    expect(setup.startAuth).not.toHaveBeenCalled();
    setup.installation = {
      ...setup.installation!,
      phase: "succeeded",
      installedVersion: "0.156.1",
      source: "managed",
    };
    await publish();
    expect(button("Sign in")).not.toBeNull();
    expect(button("Sign in")?.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <CodexSetupSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={{ ...nativeProvider, installed: true }}
          mode="existing"
          enabled
          onModeChange={vi.fn()}
        />,
      ),
    );
    await click("Sign in");
    expect(setup.startAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId },
    });
  });

  it("does not qualify an unavailable custom Codex binary from another installed runtime", async () => {
    setup.installation = { ...setup.installation!, installedVersion: "0.156.1" };
    await act(async () =>
      root.render(
        <CodexSetupSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={{
            ...provider,
            driver: ProviderDriverKind.make("codex"),
            installed: false,
            setup: { canAuthenticate: true, canInstall: false },
          }}
          mode="existing"
          enabled
          onModeChange={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("Check the configured Codex binary path.");
    expect(button("Sign in")).toBeNull();
    expect(button("Install Codex")).toBeNull();
    expect(setup.startAuth).not.toHaveBeenCalled();
    expect(setup.startInstall).not.toHaveBeenCalled();
  });

  it("offers an explicit native sign-in choice without disconnecting a managed account", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = { ...setup.installation!, installedVersion: "0.156.1" };
    const changeMode = vi.fn();
    await act(async () =>
      root.render(
        <CodexSetupSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={{
            ...provider,
            driver: ProviderDriverKind.make("codex"),
            auth: { status: "authenticated", type: "chatgpt", subscriptionSharing: true },
          }}
          mode="managed"
          enabled
          onModeChange={changeMode}
        />,
      ),
    );
    expect(container.textContent).toContain("ChatGPT token sharing");
    expect(container.textContent).toContain("Native subagents unavailable");
    expect(setup.logoutAuth).not.toHaveBeenCalled();
    expect(setup.startAuth).not.toHaveBeenCalled();
    await click("Use Codex sign-in for Live voice");
    expect(changeMode).toHaveBeenCalledExactlyOnceWith("existing");
    expect(setup.logoutAuth).not.toHaveBeenCalled();
    expect(setup.startAuth).not.toHaveBeenCalled();
  });
  it.each(["existing", "managed"] as const)(
    "creates an isolated %s account only after explicit route choice",
    async (mode) => {
      const close = vi.fn();
      await act(async () =>
        root.render(
          <AppAtomRegistryProvider>
            <AddCodexAccountDialog
              environmentId={environmentId}
              onClose={close}
              renderSetup={(_id, _provider, selectedMode) => (
                <div>Selected setup: {selectedMode}</div>
              )}
            />
          </AppAtomRegistryProvider>,
        ),
      );
      const native = document.querySelector<HTMLInputElement>('input[value="existing"]');
      expect(native?.checked).toBe(true);
      expect(setup.updateSettings).not.toHaveBeenCalled();
      if (mode === "managed") {
        const alternative = [...document.querySelectorAll("label")].find((label) =>
          label.textContent?.includes("Token sharing"),
        );
        if (!alternative) throw new Error("Expected explicit sharing choice");
        await userEvent.click(alternative);
      }
      const submit = document.querySelector<HTMLButtonElement>('button[form="add-codex-account"]');
      if (!submit) throw new Error("Expected account creation control");
      await act(async () => submit.click());
      expect(setup.updateSettings).toHaveBeenCalledTimes(1);
      const patch = setup.updateSettings.mock.calls[0]?.[0];
      if (!patch) throw new Error("Expected account update");
      expect(patch.environmentId).toBe(environmentId);
      const entries = Object.entries(patch.input.patch.providerInstances ?? {});
      const created = entries.find(([id]) => id.startsWith("codex_"));
      if (!created) throw new Error("Expected a new instance");
      const [id, raw] = created;
      const instance = decodeProviderInstance(raw);
      expect(instance.driver).toBe("codex");
      expect(instance.config).toEqual(
        mode === "existing"
          ? { enabled: true, setupMode: "existing", homePath: `~/.codex-t3/${id}` }
          : { enabled: true, setupMode: "managed" },
      );
      expect(setup.startAuth).not.toHaveBeenCalled();
      expect(setup.logoutAuth).not.toHaveBeenCalled();
      await act(async () =>
        setup.publishProviders([
          {
            ...provider,
            instanceId: ProviderInstanceId.make(id),
            driver: ProviderDriverKind.make("codex"),
            auth: { status: "unauthenticated" },
          },
        ]),
      );
      expect(document.body.textContent).toContain(`Selected setup: ${mode}`);
      expect(close).not.toHaveBeenCalled();
      await act(async () =>
        setup.publishProviders([
          {
            ...provider,
            instanceId: ProviderInstanceId.make(id),
            driver: ProviderDriverKind.make("codex"),
            auth: {
              status: "authenticated",
              type: "chatgpt",
              subscriptionSharing: mode === "managed",
            },
          },
        ]),
      );
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
  it("routes a default account through real native setup without starting token sharing", async () => {
    const close = vi.fn();
    await act(async () =>
      root.render(
        <AppAtomRegistryProvider>
          <AddManagedCodexAccountDialog environmentId={environmentId} onClose={close} />
        </AppAtomRegistryProvider>,
      ),
    );
    const submit = document.querySelector<HTMLButtonElement>('button[form="add-codex-account"]');
    if (!submit) throw new Error("Expected account creation control");
    await act(async () => submit.click());
    const request = setup.updateSettings.mock.calls[0]?.[0];
    if (!request) throw new Error("Expected account creation");
    const id = Object.keys(request.input.patch.providerInstances ?? {}).find((key) =>
      key.startsWith("codex_"),
    );
    if (!id) throw new Error("Expected isolated account ID");
    const newInstanceId = ProviderInstanceId.make(id);
    setup.auth = authState({
      instanceId: newInstanceId,
      phase: "idle",
      flowId: null,
      authorizationUrl: null,
    });
    await act(async () =>
      setup.publishProviders([
        {
          ...provider,
          instanceId: newInstanceId,
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          auth: { status: "unauthenticated" },
        },
      ]),
    );
    expect(document.body.textContent).toContain("Codex runtime");
    expect(document.body.textContent).not.toContain("ChatGPT token sharing");
    expect(setup.startAuth).not.toHaveBeenCalled();
    const signIn = [...document.querySelectorAll("button")].find(
      (element) => element.textContent === "Sign in",
    );
    if (!signIn) throw new Error("Expected explicit native sign-in");
    expect(signIn.disabled).toBe(false);
    await act(async () => signIn.click());
    expect(setup.startAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId: newInstanceId },
    });
    expect(setup.logoutAuth).not.toHaveBeenCalled();
    await act(async () =>
      setup.publishProviders([
        {
          ...provider,
          instanceId: newInstanceId,
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          auth: { status: "authenticated", type: "chatgpt" },
        },
      ]),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("shows the native device code for a remote host and opens only the user-selected verification page", async () => {
    const url = "https://auth.openai.com/codex/device";
    setup.auth = authState({
      interaction: { type: "deviceCode", id: "remote-native-code", url, userCode: "SYNTH-REMOTE" },
      authorizationUrl: url,
    });
    await act(async () =>
      root.render(
        <CodexSetupSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={{
            ...provider,
            driver: ProviderDriverKind.make("codex"),
            auth: { status: "unauthenticated" },
          }}
          mode="existing"
          enabled
          onModeChange={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("SYNTH-REMOTE");
    expect(container.textContent).toContain("in your browser");
    expect(container.querySelector(`[id="provider-callback-${instanceId}"]`)).toBeNull();
    expect(setup.openExternal).not.toHaveBeenCalled();
    expect(setup.startAuth).not.toHaveBeenCalled();
    await click("Open browser");
    expect(setup.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.respondAuth).not.toHaveBeenCalled();
    await click("Cancel");
    expect(setup.cancelAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, flowId: "flow-1" },
    });
    expect(setup.logoutAuth).not.toHaveBeenCalled();
  });
});
