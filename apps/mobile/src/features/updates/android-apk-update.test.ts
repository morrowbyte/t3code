import { describe, expect, it, vi } from "vite-plus/test";
import { ANDROID_UPDATE_CERT, ANDROID_UPDATE_PACKAGE } from "./android-apk-release";
import {
  createAndroidApkUpdater,
  type AndroidApkNative,
  type AndroidApkTransport,
} from "./android-apk-update";

function fixture(versionCode = 60) {
  const version = `0.1.2-nightly.20261019.${versionCode}`;
  const name = `Morrowbyte-${version}-android-arm64.apk`;
  const sha = "a".repeat(64);
  const source = "b".repeat(40);
  const value = {
    schemaVersion: 1,
    package: ANDROID_UPDATE_PACKAGE,
    version,
    versionCode,
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
  const release = {
    id: versionCode,
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
  };
  const transport: AndroidApkTransport = {
    releases: vi.fn(async () => ({
      repository: "morrowbyte/t3code",
      releases: [release],
    })),
    receipt: vi.fn(async () => ({ value, sha256: sha })),
    download: vi.fn(async (_release, _signal, progress) => {
      progress(500);
      return "file:///private/update.apk";
    }),
    remove: vi.fn(async () => {}),
  };
  return { native, transport, value, release, updater: createAndroidApkUpdater(transport, native) };
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
  it.each(
    ["before", "after"].flatMap((position) =>
      ["http", "schema", "digest"].map((failure) => ({ position, failure })),
    ),
  )(
    "keeps the strongest valid update with a $failure historical receipt $position it",
    async ({ position, failure }) => {
      const { updater, transport, native, release, value } = fixture();
      const historical = fixture(58);
      const strongest = fixture(62);
      vi.mocked(transport.releases).mockResolvedValue({
        repository: "morrowbyte/t3code",
        releases:
          position === "before"
            ? [historical.release, strongest.release, release]
            : [strongest.release, release, historical.release],
      });
      vi.mocked(transport.receipt).mockImplementation(async (selected) => {
        if (selected.id === historical.release.id) {
          if (failure === "http") throw new Error("Historical receipt HTTP 404");
          return {
            value: { ...historical.value, schemaVersion: failure === "schema" ? 0 : 1 },
            sha256: failure === "digest" ? "f".repeat(64) : historical.value.apkSha256,
          };
        }
        return {
          value: selected.id === strongest.release.id ? strongest.value : value,
          sha256: selected.receipt.sha256,
        };
      });
      await updater.check();
      expect(updater.getState()).toMatchObject({
        phase: "available",
        release: { id: strongest.release.id },
      });
      expect(transport.receipt).toHaveBeenCalledTimes(3);
      expect(transport.download).not.toHaveBeenCalled();
      expect(native.install).not.toHaveBeenCalled();
    },
  );
  it("keeps a receipt failure retryable when no valid higher version is available", async () => {
    const { updater, transport, release, value } = fixture();
    const historical = fixture(58);
    vi.mocked(transport.releases).mockResolvedValue({
      repository: "morrowbyte/t3code",
      releases: [historical.release, release],
    });
    vi.mocked(transport.receipt).mockImplementation(async (selected) => {
      if (selected.id === release.id) throw new Error("Receipt HTTP 404");
      return { value: historical.value, sha256: selected.receipt.sha256 };
    });
    await updater.check();
    expect(updater.getState()).toMatchObject({
      phase: "error",
      retry: "check",
      error: "Receipt HTTP 404",
    });
    vi.mocked(transport.receipt).mockImplementation(async (selected) => ({
      value: selected.id === release.id ? value : historical.value,
      sha256: selected.receipt.sha256,
    }));
    await updater.retry();
    expect(updater.getState().phase).toBe("available");
  });
  it("reports an error when every receipt fails instead of claiming the app is current", async () => {
    const { updater, transport } = fixture();
    vi.mocked(transport.receipt).mockRejectedValue(new Error("Receipt unavailable"));
    await updater.check();
    expect(updater.getState()).toMatchObject({
      phase: "error",
      retry: "check",
      error: "Receipt unavailable",
    });
  });
  it.each(["resolve", "reject"] as const)(
    "ignores a cancelled check's late receipt %s",
    async (outcome) => {
      const { updater, transport, native, release, value } = fixture();
      const older = fixture(58);
      vi.mocked(transport.releases).mockResolvedValue({
        repository: "morrowbyte/t3code",
        releases: [release, older.release],
      });
      let entered!: () => void;
      let settle!: () => void;
      let receiptSignal: AbortSignal | undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.mocked(transport.receipt).mockImplementation(async (_release, signal) => {
        receiptSignal = signal;
        entered();
        return new Promise((resolve, reject) => {
          settle = () =>
            outcome === "resolve"
              ? resolve({ value, sha256: value.apkSha256 })
              : reject(new Error("Late receipt failure"));
        });
      });
      const pending = updater.check();
      await started;
      updater.cancel();
      expect(receiptSignal?.aborted).toBe(true);
      settle();
      await pending;
      expect(updater.getState().phase).toBe("cancelled");
      expect(transport.receipt).toHaveBeenCalledOnce();
      expect(transport.download).not.toHaveBeenCalled();
      expect(native.verify).not.toHaveBeenCalled();
      expect(native.install).not.toHaveBeenCalled();
    },
  );
  it("does not continue candidate selection after an aborted receipt request", async () => {
    const { updater, transport, release } = fixture();
    const older = fixture(58);
    vi.mocked(transport.releases).mockResolvedValue({
      repository: "morrowbyte/t3code",
      releases: [release, older.release],
    });
    const abort = new Error("Receipt aborted");
    abort.name = "AbortError";
    vi.mocked(transport.receipt).mockRejectedValue(abort);
    await updater.check();
    expect(updater.getState()).toMatchObject({
      phase: "error",
      retry: "check",
      error: "Receipt aborted",
    });
    expect(transport.receipt).toHaveBeenCalledOnce();
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
