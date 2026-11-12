import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

import {
  readDesktopBrowserHostedEnvironmentIds,
  useDesktopBrowserHostedEnvironmentIds,
} from "./desktopBrowserSurface";

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom)
  ) {
    return undefined;
  }
  return "server";
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  return snapshot.runtime === "server" ? "desktop" : "server";
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
  hostedEnvironmentIds = readDesktopBrowserHostedEnvironmentIds(),
): boolean {
  return (
    snapshot?.runtime === "server" &&
    hostsPreviewTabLocally(environmentId, primaryEnvironmentId, snapshot, hostedEnvironmentIds)
  );
}

export function hostsPreviewTabLocally(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
  hostedEnvironmentIds = readDesktopBrowserHostedEnvironmentIds(),
): boolean {
  return (
    isElectron &&
    snapshot != null &&
    (snapshot.runtime !== "server" ||
      (!snapshot.headless &&
        (environmentId === primaryEnvironmentId || hostedEnvironmentIds.includes(environmentId))))
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const hostedEnvironmentIds = useDesktopBrowserHostedEnvironmentIds();
  return (
    environmentId !== null &&
    rendersServerTabNatively(environmentId, primaryEnvironmentId, snapshot, hostedEnvironmentIds)
  );
}

export function useControlsNativePreviewTab(
  environmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const hostedEnvironmentIds = useDesktopBrowserHostedEnvironmentIds();
  return (
    isElectron &&
    snapshot != null &&
    !snapshot.headless &&
    environmentId !== null &&
    (environmentId === primaryEnvironmentId || hostedEnvironmentIds.includes(environmentId))
  );
}
