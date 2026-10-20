import { describe, expect, it } from "vite-plus/test";
import {
  ANDROID_UPDATE_CERT,
  ANDROID_UPDATE_PACKAGE,
  assertAndroidInstalledIdentity,
  parseAndroidReleaseIndex,
  verifyAndroidApkProof,
} from "./android-apk-release";

const hash = "a".repeat(64);
const source = "b".repeat(40);
const version = "0.1.2-nightly.20261019.59";
const filename = `Morrowbyte-${version}-android-arm64.apk`;
const asset = (id: number, name: string, size = 1000) => ({
  id,
  name,
  size,
  sha256: hash,
});
const feed = () => ({
  id: 1,
  tagName: `v${version}`,
  version,
  source,
  changelog: "# Original changelog\n\n- Existing connections stay intact.",
  assets: [asset(2, filename), asset(3, `${filename}.json`)],
});
const identity = {
  packageName: ANDROID_UPDATE_PACKAGE,
  versionName: "0.1.2-nightly.20261018.58",
  versionCode: 58,
  certificateSha256: [ANDROID_UPDATE_CERT],
  supportedAbis: ["arm64-v8a"],
};
const proof = () => ({
  schemaVersion: 1,
  package: ANDROID_UPDATE_PACKAGE,
  certificateSha256: ANDROID_UPDATE_CERT,
  version,
  versionCode: 59,
  source,
  apk: filename,
  apkSha256: hash,
  signatureVerified: true,
  zip16KB: true,
  elf16KB: true,
  abis: ["arm64-v8a"],
});

const index = (releases: unknown[]) => ({ repository: "morrowbyte/t3code", releases });

describe("Android APK release trust", () => {
  it("accepts the known all-platform Nightly and the non-latest Android namespace", () => {
    const old = feed();
    const android = { ...feed(), id: 4, tagName: `android/v${version}` };
    expect(parseAndroidReleaseIndex(index([old, android])).map((entry) => entry.tag)).toEqual([
      old.tagName,
      android.tagName,
    ]);
    expect(parseAndroidReleaseIndex(index([old]))[0]?.changelog).toBe(old.changelog);
  });
  it("rejects foreign repositories and ignores unrelated channels or desktop-only assets", () => {
    expect(
      parseAndroidReleaseIndex(
        index([
          { ...feed(), tagName: "v0.2.0-beta.1", version: "0.2.0-beta.1" },
          { ...feed(), assets: [asset(2, "Morrowbyte-Setup.exe")] },
        ]),
      ),
    ).toEqual([]);
    expect(() =>
      parseAndroidReleaseIndex({ repository: "other/t3code", releases: [feed()] }),
    ).toThrow("repository");
  });
  it("rejects ambiguous assets and absent digests", () => {
    const release = feed();
    expect(
      parseAndroidReleaseIndex(
        index([{ ...release, assets: [...release.assets, release.assets[0]] }]),
      ),
    ).toEqual([]);
    expect(() =>
      parseAndroidReleaseIndex(
        index([
          { ...release, assets: [{ ...release.assets[0], sha256: null }, release.assets[1]] },
        ]),
      ),
    ).toThrow("SHA-256");
  });
  it("binds receipt bytes, source, version, package, ABI and signer to the APK", () => {
    const release = parseAndroidReleaseIndex(index([feed()]))[0]!;
    expect(verifyAndroidApkProof(proof(), release, hash, identity).versionCode).toBe(59);
    for (const change of [
      { package: "com.morrowbyte.t3code.dev" },
      { certificateSha256: "c".repeat(64) },
      { apkSha256: "d".repeat(64) },
      { source: "e".repeat(40) },
      { version: "0.1.2-nightly.20261019.60" },
      { versionCode: 60 },
      { abis: ["x86_64"] },
    ])
      expect(() =>
        verifyAndroidApkProof({ ...proof(), ...change }, release, hash, identity),
      ).toThrow();
    expect(() => verifyAndroidApkProof(proof(), release, "f".repeat(64), identity)).toThrow();
  });
  it("never substitutes a development package/cert or x86 emulator for production ARM64", () => {
    expect(() =>
      assertAndroidInstalledIdentity({ ...identity, packageName: "com.morrowbyte.t3code.dev" }),
    ).toThrow("production");
    expect(() =>
      assertAndroidInstalledIdentity({ ...identity, certificateSha256: ["f".repeat(64)] }),
    ).toThrow("signature");
    expect(() =>
      assertAndroidInstalledIdentity({ ...identity, supportedAbis: ["x86_64"] }),
    ).toThrow("ARM64");
  });
});
