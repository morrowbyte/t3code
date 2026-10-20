export const ANDROID_UPDATE_PACKAGE = "com.morrowbyte.t3code";
export const ANDROID_UPDATE_CERT =
  "34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2";
export const MAX_APK_BYTES = 250 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;

export interface AndroidInstalledIdentity {
  readonly packageName: string;
  readonly versionName: string;
  readonly versionCode: number;
  readonly certificateSha256: readonly string[];
  readonly supportedAbis: readonly string[];
}

export interface AndroidReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface AndroidApkRelease {
  readonly id: number;
  readonly tag: string;
  readonly version: string;
  readonly changelog: string;
  readonly source: string;
  readonly apk: AndroidReleaseAsset;
  readonly receipt: AndroidReleaseAsset;
}

export interface AndroidApkProof {
  readonly versionCode: number;
  readonly sha256: string;
  readonly abis: readonly string[];
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Android release metadata.");
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid Android release number.");
  return value;
}

function asset(value: unknown): AndroidReleaseAsset {
  const entry = record(value);
  if (
    typeof entry.name !== "string" ||
    typeof entry.sha256 !== "string" ||
    !SHA256.test(entry.sha256)
  )
    throw new Error("The release asset has no trusted SHA-256 digest.");
  return {
    id: positiveInteger(entry.id),
    name: entry.name,
    size: positiveInteger(entry.size),
    sha256: entry.sha256,
  };
}

export function parseAndroidReleaseIndex(value: unknown): readonly AndroidApkRelease[] {
  const index = record(value);
  if (
    index.repository !== "morrowbyte/t3code" ||
    !Array.isArray(index.releases) ||
    index.releases.length > 100
  )
    throw new Error("The Android release index is outside the Morrowbyte repository.");
  const releases: AndroidApkRelease[] = [];
  for (const item of index.releases) {
    const entry = record(item);
    if (typeof entry.tagName !== "string") continue;
    const tag = entry.tagName;
    const namespaced = tag.startsWith("android/v");
    const version = namespaced ? tag.slice(9) : tag.slice(1);
    if (
      !VERSION.test(version) ||
      entry.version !== version ||
      (!namespaced && !/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag))
    )
      continue;
    if (
      typeof entry.source !== "string" ||
      !/^[a-f0-9]{40}$/.test(entry.source) ||
      typeof entry.changelog !== "string" ||
      entry.changelog.length > 64_000 ||
      !Array.isArray(entry.assets) ||
      entry.assets.length > 3
    )
      continue;
    const filename = `Morrowbyte-${version}-android-arm64.apk`;
    const apkEntries = entry.assets.filter((candidate) => record(candidate).name === filename);
    const receipts = entry.assets.filter(
      (candidate) => record(candidate).name === `${filename}.json`,
    );
    if (apkEntries.length !== 1 || receipts.length !== 1) continue;
    const apk = asset(apkEntries[0]);
    const receipt = asset(receipts[0]);
    if (apk.size > MAX_APK_BYTES || receipt.size > 64_000)
      throw new Error("The Android release exceeds the download size limit.");
    releases.push({
      id: positiveInteger(entry.id),
      tag,
      version,
      changelog: entry.changelog,
      source: entry.source,
      apk,
      receipt,
    });
  }
  return releases;
}

export function assertAndroidInstalledIdentity(identity: AndroidInstalledIdentity): void {
  if (
    identity.packageName !== ANDROID_UPDATE_PACKAGE ||
    identity.certificateSha256.length !== 1 ||
    identity.certificateSha256[0] !== ANDROID_UPDATE_CERT
  )
    throw new Error("APK updates require the Morrowbyte production app and its release signature.");
  positiveInteger(identity.versionCode);
  if (!identity.supportedAbis.includes("arm64-v8a"))
    throw new Error("This Android device cannot run the published ARM64 APK.");
}

// The publisher uses RELEASE_RUN for both fields; proof validation enforces this bound.
export function androidNightlyVersionCode(version: string): number | null {
  const match = /^\d+\.\d+\.\d+-nightly\.\d{8}\.([1-9]\d*)$/.exec(version);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code <= 2_100_000_000 ? code : null;
}

export function verifyAndroidApkProof(
  value: unknown,
  release: AndroidApkRelease,
  receiptSha256: string,
  identity: AndroidInstalledIdentity,
): AndroidApkProof {
  assertAndroidInstalledIdentity(identity);
  const proof = record(value);
  const code = positiveInteger(proof.versionCode);
  const nightlyCode = androidNightlyVersionCode(release.version);
  if (
    receiptSha256 !== release.receipt.sha256 ||
    !SHA256.test(receiptSha256) ||
    proof.schemaVersion !== 1 ||
    proof.package !== ANDROID_UPDATE_PACKAGE ||
    proof.certificateSha256 !== ANDROID_UPDATE_CERT ||
    proof.version !== release.version ||
    (nightlyCode !== null && code !== nightlyCode) ||
    proof.source !== release.source ||
    proof.apk !== release.apk.name ||
    proof.apkSha256 !== release.apk.sha256 ||
    proof.signatureVerified !== true ||
    proof.zip16KB !== true ||
    proof.elf16KB !== true ||
    !Array.isArray(proof.abis) ||
    proof.abis.length !== 1 ||
    proof.abis[0] !== "arm64-v8a"
  )
    throw new Error(
      "The Android release proof does not match its asset, source or signing identity.",
    );
  return { versionCode: code, sha256: release.apk.sha256, abis: ["arm64-v8a"] };
}
