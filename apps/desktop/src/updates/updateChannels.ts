import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
// Preview builds share nightly branding but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}

/** Only the released stable and nightly trains can enter the updater. */
export function isReleasedDesktopVersionForChannel(
  version: string,
  channel: DesktopUpdateChannel,
): boolean {
  return channel === "nightly"
    ? NIGHTLY_VERSION_PATTERN.test(version) &&
        STABLE_VERSION_PATTERN.test(version.split("-")[0] ?? "")
    : STABLE_VERSION_PATTERN.test(version);
}
