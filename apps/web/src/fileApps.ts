import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type FileAppId,
} from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "./components/ui/toast";
import { fileAppsForPath } from "./fileApps.logic";
import { useRemoteOpenResolution } from "./remoteOpen";
import { serverEnvironment } from "./state/server";
import { readEnvironmentScope } from "./state/session";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";

export function useFileApps(environmentId: EnvironmentId | null) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const remote = useRemoteOpenResolution(environmentId);
  const canOperate = useAtomValue(shellEnvironment.openFile.permissionAtom(environmentId));
  const openFile = useAtomCommand(shellEnvironment.openFile, "open file");
  const appsForPath = (path: string) =>
    canOperate ? fileAppsForPath(config?.availableFileApps ?? [], remote, path) : [];

  return {
    appsForPath,
    open: async (path: string, app: FileAppId): Promise<void> => {
      if (
        environmentId === null ||
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
        !appsForPath(path).includes(app)
      )
        return;
      const result = await openFile({
        environmentId,
        input: { path: splitFilePathPosition(path).path, app },
      });
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: app === "obsidian" ? "Could not open in Obsidian" : "Could not open in default app",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  };
}
