import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_BOAT_PROJECT, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { boatEnvironment } from "~/state/boat";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "~/components/ui/toast";
import { buildThreadRouteParams } from "~/threadRoutes";

export function useBoatProjectSetup() {
  const configure = useAtomCommand(boatEnvironment.configure);
  const setup = useAtomCommand(boatEnvironment.setup, { reportFailure: false });
  const navigate = useNavigate();
  return async (environmentId: EnvironmentId, projectId: ProjectId, autoSetup: boolean) => {
    const configured = await configure({
      environmentId,
      input: { projectId, config: { ...DEFAULT_BOAT_PROJECT, enabled: true, autoSetup } },
    });
    if (configured._tag === "Failure" || !autoSetup) return false;
    const started = await setup({ environmentId, input: { projectId } });
    if (started._tag === "Failure") {
      const error = squashAtomCommandFailure(started);
      toastManager.add({
        type: "error",
        title: "Could not start Boat setup",
        description: error instanceof Error ? error.message : "Resume setup in Boat settings.",
      });
      return false;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, started.value.threadId)),
    });
    return true;
  };
}
