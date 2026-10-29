import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";

const relayUrl: unknown = Constants.expoConfig?.extra?.relay?.url;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

// Observe reads the embedded manifest, even when Metro or an OTA update overrides expoConfig.
const nativeManifest = requireOptionalNativeModule<{
  manifest?: string | typeof Constants.expoConfig;
}>("ExponentConstants")?.manifest;
const nativeConfig: typeof Constants.expoConfig =
  typeof nativeManifest === "string" ? JSON.parse(nativeManifest) : (nativeManifest ?? null);
const projectId: unknown = nativeConfig?.extra?.eas?.projectId;
const nativeEndpointUrl: unknown = nativeConfig?.extra?.eas?.observe?.endpointUrl;
const nativeIntegrationAvailable = typeof projectId === "string" && projectId.trim() !== "";
let relayEndpointUrl: string | undefined;
if (typeof relayUrl === "string" && relayUrl.trim() !== "") {
  try {
    relayEndpointUrl = new URL("/v1/mobile/observe", relayUrl.trim()).toString();
  } catch (error) {
    console.warn("[observe] invalid relay URL; crash reporting is unavailable", error);
  }
}

export const crashReportingAvailable =
  relayEndpointUrl !== undefined &&
  nativeEndpointUrl === relayEndpointUrl &&
  nativeIntegrationAvailable;

if (relayEndpointUrl && !crashReportingAvailable) {
  console.warn("[observe] crash reporting requires an embedded EAS project ID and relay endpoint");
}

// Keep the import synchronous for startup errors, but never initialize an unconfigured SDK.
const Observe = nativeIntegrationAvailable
  ? (require("expo-observe") as typeof import("expo-observe")).Observe
  : undefined;

export function reportCrashError(error: unknown) {
  Observe?.reportError(error);
}

interface PromiseRejectionTracker {
  readonly enablePromiseRejectionTracker?: (options: {
    readonly allRejections: boolean;
    readonly onUnhandled: (id: number, rejection: unknown) => void;
  }) => void;
}

// React Native tracks unhandled rejections only in development, for LogBox; Observe has no hook.
if (Observe && !__DEV__) {
  const hermes: PromiseRejectionTracker | undefined = Reflect.get(globalThis, "HermesInternal");
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, rejection) => reportCrashError(rejection),
  });
}

let latestConfiguration = 0;

// While sending is off, a dispatch pass drops what it finds, so one runs before turning it back on.
// Best effort: Observe skips the pass while it is backing off from a failed send.
export async function setCrashReportsEnabled(enabled: boolean) {
  if (!Observe) return;
  const configuration = ++latestConfiguration;
  const dispatchingEnabled = crashReportingAvailable && enabled;
  if (dispatchingEnabled) {
    await Observe.dispatchEvents();
    if (configuration !== latestConfiguration) return;
  }
  Observe.configure({
    dispatchingEnabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

if (!crashReportingAvailable) {
  void setCrashReportsEnabled(false);
} else {
  // Observe keeps its last configuration across launches; configuring it off while the setting
  // loads would drop the last session's native crash. Imported lazily so the persistence graph
  // never runs ahead of the imports `index.ts` orders first.
  const changedSinceLoad = () => latestConfiguration !== 0;
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then(
      (preferences) =>
        changedSinceLoad()
          ? undefined
          : setCrashReportsEnabled(preferences.crashReportsEnabled !== false),
      // Observe keeps the last choice it was given, which stands in for the unreadable one.
      (error: unknown) => console.warn("[observe] could not read the crash report setting", error),
    )
    .catch((error: unknown) => {
      console.warn("[observe] could not apply the crash report setting", error);
    });
}
