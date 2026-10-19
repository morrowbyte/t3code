import { describe, expect, it, vi } from "vite-plus/test";
import { ANDROID_UPDATE_CERT, ANDROID_UPDATE_PACKAGE } from "./android-apk-release";
import {
  createAndroidApkUpdater,
  type AndroidApkNative,
  type AndroidApkTransport,
} from "./android-apk-update";

function fixture() {
  const version = "0.1.2-nightly.20261019.60";
  const name = `Morrowbyte-${version}-android-arm64.apk`;
  const sha = "a".repeat(64);
  const source = "b".repeat(40);
  const value = {
    schemaVersion: 1,
    package: ANDROID_UPDATE_PACKAGE,
    version,
    versionCode: 60,
    certificateSha256: ANDROID_UPDATE_CERT,
    source,
    apk: name,
    apkSha256: sha,
    abis: ["arm64-v8a"],
    signatureVerified: true,
    zip16KB: true,
    elf16KB: true,
  };
  const native: AndroidApkNative = {
    installed: vi.fn(async () => ({
      packageName: ANDROID_UPDATE_PACKAGE,
      versionName: "installed",
      versionCode: 59,
      certificateSha256: [ANDROID_UPDATE_CERT],
      supportedAbis: ["arm64-v8a"],
    })),
    verify: vi.fn(async () => {}),
    install: vi.fn(async () => "installer-opened" as const),
    openInstallPermission: vi.fn(async () => {}),
  };
  const transport: AndroidApkTransport = {
    releases: vi.fn(async () => ({
      repository: "morrowbyte/t3code",
      releases: [
        {
          id: 1,
          tagName: `android/v${version}`,
          version,
          changelog: "Original",
          source,
          assets: [
            { id: 2, name, size: 1000 },
            { id: 3, name: `${name}.json`, size: 1000 },
          ].map((entry) => ({
            ...entry,
            sha256: sha,
          })),
        },
      ],
    })),
    receipt: vi.fn(async () => ({ value, sha256: sha })),
    download: vi.fn(async (_release, _signal, progress) => {
      progress(500);
      return "file:///private/update.apk";
    }),
    remove: vi.fn(async () => {}),
  };
  return { native, transport, value, updater: createAndroidApkUpdater(transport, native) };
}

describe("explicit Android APK updates", () => {
  it("does no startup requests and requires separate check, download and visible installer actions", async () => {
    const { updater, native, transport } = fixture();
    expect(transport.releases).not.toHaveBeenCalled();
    await updater.check();
    expect(updater.getState().phase).toBe("available");
    expect(transport.download).not.toHaveBeenCalled();
    await updater.download();
    expect(updater.getState().phase).toBe("ready");
    expect(native.verify).toHaveBeenCalledOnce();
    expect(native.install).not.toHaveBeenCalled();
    await updater.install();
    expect(updater.getState().phase).toBe("installer-opened");
    expect(native.install).toHaveBeenCalledOnce();
  });
  it("cannot download a downgrade and never trusts a mismatched receipt digest", async () => {
    const current = fixture();
    current.value.versionCode = 58;
    await current.updater.check();
    expect(current.updater.getState().phase).toBe("current");
    await current.updater.download();
    expect(current.transport.download).not.toHaveBeenCalled();
    const mismatch = fixture();
    vi.mocked(mismatch.transport.receipt).mockResolvedValue({
      value: mismatch.value,
      sha256: "f".repeat(64),
    });
    await mismatch.updater.check();
    expect(mismatch.updater.getState().phase).toBe("error");
    expect(mismatch.native.verify).not.toHaveBeenCalled();
  });
  it("cancels an in-flight transfer and discards a late file without verifying or installing it", async () => {
    const { updater, native, transport } = fixture();
    let resolveDownload!: (uri: string) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(transport.download).mockImplementation(async () => {
      started();
      return new Promise<string>((resolve) => {
        resolveDownload = resolve;
      });
    });
    await updater.check();
    const pending = updater.download();
    await entered;
    updater.cancel();
    resolveDownload("file:///private/late.apk");
    await pending;
    expect(updater.getState().phase).toBe("cancelled");
    expect(transport.remove).toHaveBeenCalledWith("file:///private/late.apk");
    expect(native.verify).not.toHaveBeenCalled();
    expect(native.install).not.toHaveBeenCalled();
  });
  it("rejects native verification failures, retains retry, and excludes double taps", async () => {
    const { updater, native, transport } = fixture();
    await updater.check();
    vi.mocked(native.verify).mockRejectedValueOnce(new Error("APK signature mismatch"));
    await Promise.all([updater.download(), updater.download()]);
    expect(transport.download).toHaveBeenCalledOnce();
    expect(updater.getState().error).toBe("APK signature mismatch");
    expect(transport.remove).toHaveBeenCalledOnce();
    await updater.retry();
    expect(updater.getState().phase).toBe("ready");
    expect(native.install).not.toHaveBeenCalled();
  });
  it("keeps install permission an explicit step, not automatic installation", async () => {
    const { updater, native } = fixture();
    vi.mocked(native.install).mockResolvedValueOnce("permission-required");
    await updater.check();
    await updater.download();
    await updater.install();
    expect(updater.getState().phase).toBe("permission-required");
    expect(native.openInstallPermission).not.toHaveBeenCalled();
    await updater.permission();
    expect(native.openInstallPermission).toHaveBeenCalledOnce();
    expect(native.install).toHaveBeenCalledOnce();
  });
});
