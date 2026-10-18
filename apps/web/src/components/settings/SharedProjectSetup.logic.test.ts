import { EnvironmentId, type RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  sharedProjectCloneSource,
  sharedProjectDestinationError,
  sharedProjectHostBlockReason,
  type SharedProjectHost,
} from "./SharedProjectSetup.logic";

const identity: RepositoryIdentity = {
  canonicalKey: "github.com/example/project",
  rootPath: "/work/project",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:example/project.git",
  },
};
const source = { workspaceRoot: "/work/project", repositoryIdentity: identity };
const host: SharedProjectHost = {
  environmentId: EnvironmentId.make("target"),
  label: "Target",
  connected: true,
  platform: "linux",
  canCreateProject: true,
  canWriteSourceControl: true,
  supportsTrackedClones: true,
  hasCheckout: false,
};

describe("shared project setup guards", () => {
  it("reuses the existing repository identity and network clone URL", () => {
    expect(sharedProjectCloneSource(source)).toEqual({
      remoteUrl: identity.locator.remoteUrl,
      repositoryKey: identity.canonicalKey,
    });
  });
  it("keeps unresolved, subdirectory and fork identities out of a misleading shared setup", () => {
    expect(sharedProjectCloneSource({ workspaceRoot: source.workspaceRoot })).toHaveProperty(
      "error",
    );
    expect(
      sharedProjectCloneSource({ ...source, workspaceRoot: "/work/project/apps/web" }),
    ).toHaveProperty("error");
    expect(
      sharedProjectCloneSource({
        ...source,
        repositoryIdentity: { ...identity, origin: { canonicalKey: "github.com/other/fork" } },
      }),
    ).toHaveProperty("error");
  });
  it.each([
    "/local/repo",
    "file:///local/repo",
    "https://secret@github.com/example/project.git",
    "https://github.com/example/project.git?token=secret",
  ])("rejects a local or credential-bearing remote: %s", (remoteUrl) => {
    const repositoryIdentity = { ...identity, locator: { ...identity.locator, remoteUrl } };
    expect(sharedProjectCloneSource({ ...source, repositoryIdentity })).toHaveProperty("error");
  });
  it("offers only connected, authorized hosts with the existing tracked-clone path", () => {
    expect(sharedProjectHostBlockReason(host)).toBeNull();
    for (const blocked of [
      { connected: false },
      { canCreateProject: false },
      { canWriteSourceControl: false },
      { supportsTrackedClones: false },
      { hasCheckout: true },
    ])
      expect(sharedProjectHostBlockReason({ ...host, ...blocked })).not.toBeNull();
  });
  it("binds paths to the target platform and protects already registered projects", () => {
    expect(sharedProjectDestinationError("/work/new", "linux", [])).toBeNull();
    expect(sharedProjectDestinationError("C:\\Projects\\new", "windows", [])).toBeNull();
    expect(
      sharedProjectDestinationError("/work/new", "linux", [{ workspaceRoot: "/work/new/" }]),
    ).not.toBeNull();
    expect(sharedProjectDestinationError("C:\\Projects\\new", "linux", [])).not.toBeNull();
    expect(sharedProjectDestinationError("/work/new", "windows", [])).not.toBeNull();
    for (const path of ["", "relative/project", "~/project", "C:"])
      expect(sharedProjectDestinationError(path, "linux", [])).not.toBeNull();
  });
});
