import * as NodeModule from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  expoConfig: {} as { extra?: Record<string, unknown> },
  manifest: null as string | object | null,
  loadPreferences: vi.fn<() => Promise<{ crashReportsEnabled?: boolean }>>(),
}));

vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return fixture.expoConfig;
    },
    easConfig: { projectId: "runtime-only-project" },
  },
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) => {
    expect(name).toBe("ExponentConstants");
    return { manifest: fixture.manifest };
  },
}));
vi.mock("../../persistence/imperative", () => ({ loadPreferences: fixture.loadPreferences }));
vi.mock("expo-observe", () => {
  throw new Error("Project ID is required to send observability metrics.");
});

const relayUrl = "https://relay.example.test";
const endpointUrl = `${relayUrl}/v1/mobile/observe`;
const nativeConfig = {
  extra: { eas: { projectId: "embedded-project", observe: { endpointUrl } } },
};

function setup(manifest: string | object | null = JSON.stringify(nativeConfig)) {
  vi.resetModules();
  fixture.expoConfig = { extra: { relay: { url: relayUrl }, appVariant: "development" } };
  fixture.manifest = manifest;
  const preferences = Promise.withResolvers<{ crashReportsEnabled?: boolean }>();
  fixture.loadPreferences.mockReset().mockReturnValue(preferences.promise);
  let sending = false;
  const buffered = ["previous native crash"];
  const sent: string[] = [];
  const configured = Promise.withResolvers<void>();
  const configure = vi.fn((config: { dispatchingEnabled: boolean; environment?: string }) => {
    sending = config.dispatchingEnabled;
    configured.resolve();
  });
  const dispatchEvents = vi.fn(async () => {
    const events = buffered.splice(0);
    if (sending) sent.push(...events);
  });
  const reportError = vi.fn((error: unknown) => buffered.push(String(error)));
  const loadSdk = vi.fn(() => ({ Observe: { configure, dispatchEvents, reportError } }));
  const trackRejections = vi.fn();
  const globals = new DisposableStack();
  globals.defer(() => vi.unstubAllGlobals());
  const originalRequire = NodeModule.Module.prototype.require;
  const requireSpy = vi.spyOn(NodeModule.Module.prototype, "require").mockImplementation(function (
    this: NodeModule.Module,
    id,
  ) {
    return id === "expo-observe" ? loadSdk() : originalRequire.call(this, id);
  });
  globals.defer(() => requireSpy.mockRestore());
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal("HermesInternal", { enablePromiseRejectionTracker: trackRejections });
  return {
    [Symbol.dispose]: () => globals.dispose(),
    preferences,
    configured: configured.promise,
    configure,
    dispatchEvents,
    reportError,
    loadSdk,
    trackRejections,
    buffered,
    sent,
    setSending: (enabled: boolean) => (sending = enabled),
  };
}

describe("optional crash reporting", () => {
  it.each([
    { name: "missing manifest", manifest: null },
    {
      name: "missing embedded project ID",
      manifest: { extra: { eas: { observe: { endpointUrl } } } },
    },
    { name: "blank embedded project ID", manifest: { extra: { eas: { projectId: " " } } } },
  ])("does not initialize an unconfigured native integration: $name", async ({ manifest }) => {
    using context = setup(manifest);
    using _warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.expoConfig.extra!.eas = { projectId: "metro-only-project" };
    context.loadSdk.mockImplementation(() => {
      throw new Error("Project ID is required to send observability metrics.");
    });

    const observe = await import("./observe");
    expect(observe.crashReportingAvailable).toBe(false);
    await observe.setCrashReportsEnabled(true);
    await observe.setCrashReportsEnabled(false);
    observe.reportCrashError(new Error("caught render failure"));
    expect(context.loadSdk).not.toHaveBeenCalled();
    expect(context.trackRejections).not.toHaveBeenCalled();
    expect(fixture.loadPreferences).not.toHaveBeenCalled();
  });

  it.each([
    { url: null, endpoint: endpointUrl },
    { url: " ", endpoint: endpointUrl },
    { url: "invalid relay URL", endpoint: endpointUrl },
    { url: relayUrl, endpoint: undefined },
    { url: relayUrl, endpoint: "https://observe.invalid" },
  ])(
    "stops a usable native integration without a matching relay: %j",
    async ({ url, endpoint }) => {
      using context = setup();
      using _warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      fixture.expoConfig.extra!.relay = { url };
      fixture.manifest = {
        extra: { eas: { projectId: "embedded-project", observe: { endpointUrl: endpoint } } },
      };
      context.setSending(true);
      const observe = await import("./observe");
      expect(observe.crashReportingAvailable).toBe(false);
      await observe.setCrashReportsEnabled(true);
      expect(context.configure).toHaveBeenLastCalledWith({
        dispatchingEnabled: false,
        environment: "development",
      });
      observe.reportCrashError("disabled error");
      await context.dispatchEvents();
      expect(context.sent).toEqual([]);
      expect(fixture.loadPreferences).not.toHaveBeenCalled();
    },
  );

  it("retains the SDK diagnosis if a configured native integration fails", async () => {
    using context = setup();
    context.loadSdk.mockImplementation(() => {
      throw new Error("Native module failure");
    });
    await expect(import("./observe")).rejects.toThrow("Native module failure");
  });

  it.each([JSON.stringify(nativeConfig), nativeConfig])(
    "captures early errors without dropping the previous native crash while consent loads (%#)",
    async (manifest) => {
      using context = setup(manifest);
      context.setSending(true);
      const observe = await import("./observe");
      expect(observe.crashReportingAvailable).toBe(true);
      expect(context.loadSdk).toHaveBeenCalledOnce();
      expect(context.configure).not.toHaveBeenCalled();
      expect(context.dispatchEvents).not.toHaveBeenCalled();
      observe.reportCrashError("render error");
      const handler = context.trackRejections.mock.calls[0]![0].onUnhandled;
      handler(1, "unhandled rejection");
      context.preferences.resolve({});
      await context.configured;
      expect(context.sent).toEqual([
        "previous native crash",
        "render error",
        "unhandled rejection",
      ]);
      expect(context.configure).toHaveBeenLastCalledWith({
        dispatchingEnabled: true,
        environment: "development",
      });
    },
  );

  it("discards opted-out data before re-enabling and honors a newer opt-out during dispatch", async () => {
    using context = setup();
    const observe = await import("./observe");
    context.preferences.resolve({ crashReportsEnabled: false });
    await context.configured;
    expect(context.dispatchEvents).not.toHaveBeenCalled();
    observe.reportCrashError("disabled error");
    await observe.setCrashReportsEnabled(true);
    expect(context.sent).toEqual([]);
    expect(context.buffered).toEqual([]);
    observe.reportCrashError("enabled error");
    await context.dispatchEvents();
    expect(context.sent).toEqual(["enabled error"]);

    const dispatch = Promise.withResolvers<void>();
    context.dispatchEvents.mockReturnValueOnce(dispatch.promise);
    const enabling = observe.setCrashReportsEnabled(true);
    await observe.setCrashReportsEnabled(false);
    dispatch.resolve();
    await enabling;
    expect(context.configure).toHaveBeenLastCalledWith({
      dispatchingEnabled: false,
      environment: "development",
    });
  });

  it("does not replace an explicit opt-out with a late persisted preference", async () => {
    using context = setup();
    const observe = await import("./observe");
    await observe.setCrashReportsEnabled(false);
    context.preferences.resolve({ crashReportsEnabled: true });
    await vi.dynamicImportSettled();
    expect(context.configure).toHaveBeenCalledTimes(1);
    expect(context.configure).toHaveBeenLastCalledWith({
      dispatchingEnabled: false,
      environment: "development",
    });
  });
});
