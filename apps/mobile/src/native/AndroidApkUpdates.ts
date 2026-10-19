import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { AndroidInstalledIdentity } from "../features/updates/android-apk-release";
import type { AndroidApkNative } from "../features/updates/android-apk-update";

interface AndroidUpdateModule {
  getAndroidUpdateIdentity?(): Promise<AndroidInstalledIdentity>;
  verifyAndroidUpdate?(
    uri: string,
    sha256: string,
    version: string,
    code: number,
    bytes: number,
  ): Promise<void>;
  openAndroidUpdateInstaller?(
    uri: string,
    sha256: string,
    version: string,
    code: number,
    bytes: number,
  ): Promise<"permission-required" | "installer-opened">;
  openAndroidUpdateInstallPermission?(): Promise<void>;
}

const nativeControls =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidUpdateModule>("T3NativeControls")
    : null;

function supported() {
  if (
    !nativeControls?.getAndroidUpdateIdentity ||
    !nativeControls.verifyAndroidUpdate ||
    !nativeControls.openAndroidUpdateInstaller ||
    !nativeControls.openAndroidUpdateInstallPermission
  )
    throw new Error("This app version does not include the Android APK updater yet.");
  return {
    installed: nativeControls.getAndroidUpdateIdentity.bind(nativeControls),
    verify: nativeControls.verifyAndroidUpdate.bind(nativeControls),
    install: nativeControls.openAndroidUpdateInstaller.bind(nativeControls),
    permission: nativeControls.openAndroidUpdateInstallPermission.bind(nativeControls),
  };
}

export const androidApkNative: AndroidApkNative = {
  installed: () => supported().installed(),
  verify: (uri, release, proof) =>
    supported().verify(uri, proof.sha256, release.version, proof.versionCode, release.apk.size),
  install: (uri, release, proof) =>
    supported().install(uri, proof.sha256, release.version, proof.versionCode, release.apk.size),
  openInstallPermission: () => supported().permission(),
};
