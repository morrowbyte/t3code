import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import {
  readDesktopBrowserHostedEnvironmentIds,
  readDesktopBrowserHostState,
} from "./desktopBrowserSurface";

/** Server tab ids are epoch-scoped; only a confirmed Main guest keeps its attached host id. */
export function previewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
  desktopHostId?: string,
): string {
  if (desktopHostId && isConfirmedPreviewDesktopHostId(threadRef, tabId, desktopHostId))
    return desktopHostId;
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, serverEpoch, tabId]);
}

export function isConfirmedPreviewDesktopHostId(
  threadRef: ScopedThreadRef,
  tabId: string,
  desktopHostId: string,
): boolean {
  if (
    threadRef.environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom) &&
    !readDesktopBrowserHostedEnvironmentIds().includes(threadRef.environmentId)
  ) {
    return false;
  }
  const host = readDesktopBrowserHostState(desktopHostId);
  if (!host || host.webContentsId === null || (host.kind !== "offscreen" && host.kind !== "webview"))
    return false;
  try {
    const identity: unknown = JSON.parse(desktopHostId);
    return (
      Array.isArray(identity) &&
      identity.length === 4 &&
      identity[0] === threadRef.environmentId &&
      identity[1] === threadRef.threadId &&
      (identity[2] === null || typeof identity[2] === "string") &&
      identity[3] === tabId &&
      JSON.stringify(identity) === desktopHostId
    );
  } catch {
    return false;
  }
}
