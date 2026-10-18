import { RegistryContext } from "@effect/atom-react";
import "../../index.css";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { EnvironmentPresentation } from "../../state/environments";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({
  environments: [] as EnvironmentPresentation[],
  projects: [] as Project[],
  grants: new Map<EnvironmentId, Set<AuthEnvironmentScope>>(),
  startClone: vi.fn(),
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentsWithScope: ((
    environments: readonly { environmentId: EnvironmentId }[],
    scope: AuthEnvironmentScope,
  ) =>
    new Set(
      environments
        .filter((entry) => state.grants.get(entry.environmentId)?.has(scope))
        .map((entry) => entry.environmentId),
    )) as never,
  readEnvironmentScope: (id: EnvironmentId, scope: AuthEnvironmentScope) =>
    state.grants.get(id)?.has(scope) === true,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: (() => DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.startClone) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  )) as never,
  SettingsRow: (({
    title,
    description,
    control,
  }: {
    title: string;
    description: string;
    control: React.ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      <p>{description}</p>
      {control}
    </div>
  )) as never,
}));
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { SharedProjectSetup } from "./SharedProjectSetup";

const sourceId = EnvironmentId.make("source");
const targetId = EnvironmentId.make("target");
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.environments = [sourceId, targetId].map((environmentId) => ({
    environmentId,
    label: environmentId === sourceId ? "Source host" : "Target host",
    connection: { phase: "connected" },
    serverConfig: {
      environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
    },
  })) as EnvironmentPresentation[];
  state.grants = new Map(
    [sourceId, targetId].map((id) => [
      id,
      new Set([
        AuthOrchestrationOperateScope,
        AuthOrchestrationReadScope,
        AuthSourceControlWriteScope,
      ]),
    ]),
  );
  state.projects = [
    {
      environmentId: sourceId,
      id: ProjectId.make("synthetic-source"),
      title: "Shared fixture",
      workspaceRoot: "/synthetic/source",
      repositoryIdentity: {
        canonicalKey: "github.com/example/fixture",
        rootPath: "/synthetic/source",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/example/fixture.git",
        },
      },
      scripts: [],
      createdAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
      defaultModelSelection: null,
    },
  ];
  state.startClone.mockResolvedValue(AsyncResult.success({}));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  const group = buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: sourceId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!;
  await act(async () =>
    root.render(
      <RegistryContext value={appAtomRegistry}>
        <SharedProjectSetup group={group} />
      </RegistryContext>,
    ),
  );
}
async function open() {
  await render();
  await userEvent.click(container.querySelector("button")!);
  await userEvent.click(document.querySelector('[id="shared-project-host"]')!);
  await userEvent.click(
    Array.from(document.querySelectorAll('[role="option"]')).find(
      (node) => node.textContent === "Target host",
    )!,
  );
  await userEvent.fill(
    document.querySelector<HTMLInputElement>("#shared-project-path")!,
    "/synthetic/target",
  );
}
const submit = () =>
  Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === "Clone on host",
  )!;

describe("shared project setup", () => {
  it("starts one normal tracked clone on the selected host without copying scripts or changing the source", async () => {
    const original = structuredClone(state.projects);
    await open();
    await userEvent.click(document.querySelector('[role="checkbox"]')!);
    expect(submit().disabled).toBe(false);
    await userEvent.click(submit());
    expect(state.startClone).toHaveBeenCalledExactlyOnceWith({
      environmentId: targetId,
      input: {
        projectId: expect.any(String),
        title: "Shared fixture",
        createdAt: expect.any(String),
        remoteUrl: "https://github.com/example/fixture.git",
        destinationPath: "/synthetic/target",
      },
    });
    expect(state.projects).toEqual(original);
  });
  it("requires the remote-only choice again after cancelling and reopening", async () => {
    await open();
    expect(submit().disabled).toBe(true);
    await userEvent.click(document.querySelector('[role="checkbox"]')!);
    expect(submit().disabled).toBe(false);
    await userEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (node) => node.textContent === "Cancel",
      )!,
    );
    await open();
    expect(submit().disabled).toBe(true);
    expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(state.startClone).not.toHaveBeenCalled();
  });
  it("rechecks revoked target permissions at the click boundary", async () => {
    await open();
    await userEvent.click(document.querySelector('[role="checkbox"]')!);
    state.grants.get(targetId)!.delete(AuthSourceControlWriteScope);
    await userEvent.click(submit());
    expect(state.startClone).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("permissions changed");
  });
  it("disables a host that disconnects while the form is open", async () => {
    await open();
    await userEvent.click(document.querySelector('[role="checkbox"]')!);
    state.environments = state.environments.map((entry) =>
      entry.environmentId === targetId
        ? ({
            ...entry,
            connection: { ...entry.connection, phase: "offline" },
          } as EnvironmentPresentation)
        : entry,
    );
    await render();
    expect(submit().disabled).toBe(true);
    expect(state.startClone).not.toHaveBeenCalled();
  });
});
