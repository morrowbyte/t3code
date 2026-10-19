import {
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { isAbsolutePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  findProjectByPath,
  normalizeProjectPathForComparison,
} from "@t3tools/client-runtime/state/projects";

export interface SharedProjectHost {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly platform: string | undefined;
  readonly canCreateProject: boolean;
  readonly canWriteSourceControl: boolean;
  readonly supportsTrackedClones: boolean;
  readonly hasCheckout: boolean;
}

export function sharedProjectHostBlockReason(host: SharedProjectHost): string | null {
  if (host.hasCheckout) return "Already set up";
  if (!host.connected) return "Connect this host first";
  if (!host.canCreateProject || !host.canWriteSourceControl)
    return "Requires project and source-control write permissions";
  if (!host.supportsTrackedClones) return "Update this host to support tracked clones";
  return null;
}

export function sharedProjectCloneSource(project: {
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}): { remoteUrl: string; repositoryKey: string } | { error: string } {
  const identity = project.repositoryIdentity;
  if (!identity?.rootPath) return { error: "Repository identity is not available yet." };
  if (
    normalizeProjectPathForComparison(project.workspaceRoot) !==
    normalizeProjectPathForComparison(identity.rootPath)
  )
    return { error: "Set up the repository root project to clone it on another host." };
  const remoteUrl = identity.locator.remoteUrl;
  const repositoryKey = repositoryGroupingKeyOf(identity);
  if (normalizeGitRemoteUrl(remoteUrl) !== repositoryKey)
    return {
      error:
        "This checkout uses different origin and upstream repositories. Add its origin on the other host first.",
    };
  if (/^(https?|ssh|git):\/\//i.test(remoteUrl)) {
    try {
      const url = new URL(remoteUrl);
      if (
        !url.hostname ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "ssh:" && url.username)
      )
        return { error: "Use a Git remote without embedded credentials." };
    } catch {
      return { error: "This project needs a valid network Git remote." };
    }
  } else if (!/^[\w.-]+@[\w.-]+:.+/.test(remoteUrl)) {
    return { error: "Local Git paths cannot be cloned onto another host." };
  }
  return { remoteUrl, repositoryKey };
}

export function sharedProjectDestinationError(
  path: string,
  platform: string | undefined,
  projects: ReadonlyArray<{ workspaceRoot: string }>,
): string | null {
  const value = path.trim();
  if (!value) return "Enter a new checkout path on the selected host.";
  if (!isAbsolutePath(value) || /^[a-z]:$/i.test(value))
    return "Use an absolute path on the selected host.";
  if (platform === "windows" ? !isWindowsAbsolutePath(value) : isWindowsAbsolutePath(value))
    return "The path must match the selected host's operating system.";
  if (findProjectByPath(projects, value))
    return "A project already uses this path on the selected host.";
  return null;
}
