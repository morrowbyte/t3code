import type { ExpoConfig } from "expo/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";
const runtimeVersionPolicy =
  process.env.MOBILE_VERSION_POLICY ??
  (APP_VARIANT === "development" ? "appVersion" : "fingerprint");

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// Compiled into the native project. Without a relay, Observe's native side could dispatch to
// Expo's own ingest before observe.ts turns it off; `.invalid` never resolves (RFC 6761).
const observeEndpointUrl = repoEnv.T3CODE_RELAY_URL?.trim()
  ? new URL("/v1/mobile/observe", repoEnv.T3CODE_RELAY_URL.trim()).toString()
  : "https://observe.invalid";

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;
const androidAdaptiveForeground = "./assets/android-icon-foreground.png";

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

const CREW_ASSETS = {
  appIcon: fromRepoRoot("assets/crew/native-1024.png"),
  iosIcon: fromRepoRoot("assets/crew/native-1024.png"),
  splashIcon: fromRepoRoot("assets/crew/native-1024.png"),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#292B2E",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#789C90",
} as const;

const DEVELOPMENT_ASSETS = {
  ...CREW_ASSETS,
  androidSplashIcon: "./assets/android-splash-icon-dev.png",
} as const;

const PREVIEW_ASSETS = {
  ...CREW_ASSETS,
  androidSplashIcon: "./assets/android-splash-icon-nightly.png",
} as const;

const RELEASE_ASSETS = {
  ...CREW_ASSETS,
  androidSplashIcon: "./assets/android-splash-icon-prod.png",
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "Crew Dev",
    scheme: "morrowbyte-dev",
    iosBundleIdentifier: "com.t3tools.t3code.dev",
    androidPackage: "com.morrowbyte.t3code.dev",
    relyingParty: "clerk.t3.codes",
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    appName: "Crew Preview",
    scheme: "morrowbyte-preview",
    iosBundleIdentifier: "com.t3tools.t3code.preview",
    androidPackage: "com.morrowbyte.t3code.preview",
    relyingParty: "clerk.t3.codes",
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "Crew",
    scheme: "morrowbyte",
    iosBundleIdentifier: "com.t3tools.t3code",
    androidPackage: "com.morrowbyte.t3code",
    relyingParty: "clerk.t3.codes",
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const androidVersionCode = Number(repoEnv.MORROWBYTE_ANDROID_VERSION_CODE ?? "1");
if (
  !Number.isInteger(androidVersionCode) ||
  androidVersionCode < 1 ||
  androidVersionCode > 2_100_000_000
) {
  throw new Error("MORROWBYTE_ANDROID_VERSION_CODE must be a positive Android version code.");
}
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : variant.iosBundleIdentifier;
const microphonePermission = "Allow Crew to use your microphone for voice input.";

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    // Frequent updates need the iOS entitlement to avoid early throttling.
    frequentUpdates: true,
    enableAndroid: true,
    widgets: [
      {
        name: "SubscriptionUsage",
        displayName: "Crew usage",
        description: "Subscription quotas from your connected Crew environments.",
        ios: {
          configuration: {
            title: "Subscription usage",
            description:
              "Both shows Session and Weekly when available. The Lock Screen shows the tightest selected limit.",
            parameters: {
              codexPeriod: {
                title: "Codex limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
              claudePeriod: {
                title: "Claude limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
            },
          },
          supportedFamilies: [
            "systemSmall",
            "systemMedium",
            "systemLarge",
            "systemExtraLarge",
            "accessoryRectangular",
          ],
        },
        android: {
          minWidth: 250,
          minHeight: 180,
          targetCellWidth: 4,
          targetCellHeight: 3,
          resizeMode: "both",
          // The embedded layout renders before first launch; publishing replaces it with stored props.
          initialLayout: "./src/widgets/SubscriptionUsage.android.tsx",
        },
      },
      {
        name: "AgentActivity",
        displayName: "Crew activity",
        description: "Shows the current state of active Crew agents.",
        android: null,
        ios: { supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"] },
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets; keep local builds usable.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
        supportsMovieWithMaxCount: 8,
        supportsFileWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["*/*"],
      multipleShareMimeTypes: ["*/*"],
    },
  },
];

// Match iOS PostScript names on Android so RN and the native composer share fonts before runtime loading.

const config: ExpoConfig = {
  name: variant.appName,
  slug: "morrowbyte",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: repoEnv.T3CODE_MOBILE_VERSION ?? "2.2.0",
  runtimeVersion: {
    // Skip costly fingerprinting on dev launches; preview and production OTAs require matching native projects.
    policy: runtimeVersionPolicy,
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  updates: {
    enabled: false,
  },
  ios: {
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    // Avoid Personal Team fallback: it cannot sign App Groups, Apple sign-in or push entitlements.
    appleTeamId: "ARK85ZXQ4Z",
    associatedDomains: [
      `applinks:${variant.relyingParty}`,
      `webcredentials:${variant.relyingParty}`,
    ],
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${variant.iosBundleIdentifier}`],
    },
    infoPlist: {
      UISupportedInterfaceOrientations: [
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
      ],
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow Crew to connect to Crew and T3 Code servers on your local network or tailnet.",
      NSPhotoLibraryAddUsageDescription: "Allow Crew to save images to your photo library.",
      // System picture in picture needs background audio to start and survive outside the app.
      UIBackgroundModes: ["audio"],
      ITSAppUsesNonExemptEncryption: false,
      // Capture builds disable multitasking because iPadOS otherwise ignores orientation requests.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    versionCode: androidVersionCode,
    permissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.CHANGE_NETWORK_STATE",
    ],
    ...(repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE
      ? { googleServicesFile: repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE }
      : {}),
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      foregroundImage: variant.assets.androidAdaptiveForeground,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // JS back dispatch needs RN's Android 16 shim and withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
    // expo-sensors declares this for its pedometer, which the app does not use.
    blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    "expo-asset",
    "react-native-pdf-jsi",
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    [
      "expo-notifications",
      {
        icon: variant.assets.androidNotificationIcon,
        color: variant.assets.androidNotificationColor,
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    // Gate Clerk here: withoutIosPersonalTeamCapabilities runs too early to strip its entitlement.
    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
          },
        },
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission,
        recordAudioAndroid: true,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Allow Crew to access your camera so you can scan pairing QR codes.",
        microphonePermission,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    // Image picker treats false as an app-wide RECORD_AUDIO block, including voice.
    ["expo-image-picker", { photosPermission: false, microphonePermission }],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#292B2E",
        imageWidth: 220,
        dark: {
          image: variant.assets.splashIcon,
          backgroundColor: "#292B2E",
        },
        android: {
          // Android 12+ masks the central two thirds of its 288dp canvas. Use the
          // padded mark export so the launcher and splash retain the same silhouette.
          image: variant.assets.androidSplashIcon,
          imageWidth: 288,
          dark: { image: variant.assets.androidSplashIcon },
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 24,
          // SDK 58 lacks Kotlin 2.3's runtime-inert annotation. R8 needs explicit InputMerger constructors for widgets.
          extraProguardRules: [
            "-dontwarn kotlin.MustUseReturnValues",
            "-keep class * extends androidx.work.InputMerger { <init>(); }",
            "-keep class org.webrtc.** { *; }",
            // Jitsi's native bootstrap calls JNI Zero's annotated Java callbacks by name.
            "-keepclasseswithmembers,includedescriptorclasses class org.jni_zero.** { @org.jni_zero.CalledByNative <methods>; }",
            // Jitsi 155 retains an unused Dav1d JNI wrapper but omits its AV1 decoder interface.
            "-dontwarn org.webrtc.Dav1dDecoder$Natives",
          ].join("\n"),
        },
        ios: {
          deploymentTarget: "18.0",
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    // Compile out the unused pedometer to avoid an iOS motion purpose string.
    ["expo-sensors", { motionPermission: false }],
    // Mods run in reverse order; expo-widgets must create and wipe the target before assets are added.
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    "./plugins/withAndroidNetworkSecurityConfig.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withOptionalObserve.cjs",
    "./plugins/withAndroidReleaseSigning.cjs",
    "./plugins/withAndroidInputBackground.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    // Clerk reads these exact names at prebuild. Omit unset values: manifest null becomes truthy {}.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    eas: {
      observe: { endpointUrl: observeEndpointUrl },
    },
  },
  experiments: {
    // Metro only runs babel-plugin-react-compiler when this is set; see src/reactCompilerCoverage.test.ts.
    reactCompiler: true,
  },
};

export default config;
