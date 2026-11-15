import type { ProjectFaviconTarget } from "@t3tools/client-runtime/project-favicon-cache";
import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  projectFaviconResource,
} from "@t3tools/client-runtime/state/assets";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectFaviconCache } from "../assets/projectFaviconCache";
import { environmentProjectClonesAtom } from "./projectClones";
import { environmentSession } from "./session";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectClonesAtom,
});

/**
 * Asks the server for a project's icon again. Choosing the icon path a project had before would
 * otherwise reuse that path's cached URL, which says "missing" if the file did not exist then.
 */
export function refreshProjectFaviconUrl(target: ProjectFaviconTarget) {
  appAtomRegistry.refresh(
    assetEnvironment.createUrl({
      environmentId: target.environmentId,
      input: { resource: projectFaviconResource(target.cwd, target.faviconPath) },
    }),
  );
}
