import type { FileAppId } from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";

import type { RemoteOpenResolution } from "./remoteOpen";

export function fileAppsForPath(
  availableApps: ReadonlyArray<FileAppId>,
  remote: RemoteOpenResolution,
  filePath: string,
): ReadonlyArray<FileAppId> {
  if (!remote.isResolved || remote.state.mode !== "local-exec") return [];
  const path = splitFilePathPosition(filePath).path;
  return availableApps.filter((app) => app !== "obsidian" || /\.(md|excalidraw)$/i.test(path));
}
