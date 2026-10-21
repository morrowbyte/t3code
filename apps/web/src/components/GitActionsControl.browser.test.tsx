import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, memo, StrictMode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

type Branched = { readonly branch: string };
type GitActionInput = { featureBranch?: boolean; threadId?: string; action: string };
type Toast = { actionProps?: { onClick: () => void } };

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  shell: null as Branched | null,
  detail: null as Branched | null,
  draft: null as (Branched & { worktreePath: null; envMode: "local" }) | null,
  branch: "main",
  isDefaultRef: false,
  actions: [] as { scope: { cwd: string | null }; input: GitActionInput }[],
  metadataRequests: [] as { environmentId: string; branch: string }[],
  toasts: [] as Toast[],
  afterGitAction: undefined as (() => void) | undefined,
}));

vi.mock(import("~/state/session"), async (original) => {
  const hasScope = (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null || state.shell === null ? null : { ...state.shell, id: ref.threadId }) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null || state.detail === null
      ? null
      : { projection: { thread: state.detail } }) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  // Serves both the VCS status and the source-control discovery queries.
  useEnvironmentQuery: (() => ({
    data: {
      sourceControlProviders: [],
      isRepo: true,
      refName: state.branch,
      isDefaultRef: state.isDefaultRef,
      hasPrimaryRemote: true,
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "file.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    },
    error: null,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  // The only command whose result matters here is the thread's branch metadata update.
  useAtomCommand: ((_command: unknown, options: unknown) =>
    options === "thread branch metadata update"
      ? async ({ environmentId, input }: { environmentId: string; input: { branch: string } }) => {
          state.metadataRequests.push({ environmentId, branch: input.branch });
          if (!state.scopes.has(AuthOrchestrationOperateScope))
            return AsyncResult.failure(Cause.fail(new Error("Task denied")));
          if (state.shell) state.shell = { branch: input.branch };
          if (state.detail) state.detail = { branch: input.branch };
          return AsyncResult.success(undefined);
        }
      : async () => AsyncResult.success(undefined)) as never,
}));
vi.mock(import("~/lib/sourceControlActions"), async (original) => ({
  ...(await original()),
  useSourceControlActionRunning: () => false,
  useGitStackedAction: ((scope: { cwd: string | null }) => ({
    run: async (input: GitActionInput) => {
      state.actions.push({ scope, input });
      if (input.featureBranch) state.branch = "feature";
      state.afterGitAction?.();
      return {
        _tag: "Success",
        value: {
          branch: input.featureBranch
            ? { status: "created", name: "feature" }
            : { status: "skipped_not_requested" },
          toast: {
            title: "Committed",
            description: "Committed",
            cta: {
              kind: "run_action",
              label: "Push & create PR",
              action: { kind: "commit_push_pr" },
            },
          },
        },
      };
    },
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => async () => {}) as never,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: ((toast: Toast) => {
        state.toasts.push(toast);
        return "toast";
      }) as never,
    },
  };
});
vi.mock(import("~/hooks/useT3ProjectFileScripts"), () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock(import("./BranchToolbar"), () => ({ BranchToolbar: () => null }));
vi.mock(import("./chat/ThreadAutomationsPanel"), () => ({ ThreadAutomationsPanel: () => null }));
vi.mock(import("./chat/ThreadRelationshipsControl"), () => ({
  ThreadRelationshipsPanel: () => null,
}));

import { useComposerDraftStore } from "~/composerDraftStore";
import GitActionsControl from "./GitActionsControl";
import { ThreadDetailsPanel } from "./chat/ThreadDetailsPanel";
import { PopoverCreateHandle, PopoverTrigger } from "./ui/popover";
import { dispatchKeyboardCommand } from "./keyboard/keyboardCommands";
import { WorkbenchCommandPicker } from "./keyboard/WorkbenchCommandPicker";
import { useRightPanelStore } from "~/rightPanelStore";

// ThreadDetailsPanel keeps this component mounted behind React.memo when threads change.
const MemoGitActionsControl = memo(GitActionsControl);

let root: Root;
let container: HTMLDivElement;

function render(thread = "thread", cwd = "/repo") {
  return act(async () =>
    root.render(
      <MemoGitActionsControl
        gitCwd={cwd}
        activeThreadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make(thread),
        }}
      />,
    ),
  );
}

const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
const commits = () => state.actions.length;

async function openCommitDialog() {
  await userEvent.click(button("Git action options"));
  await userEvent.click(page.getByRole("menuitem", { name: "Commit" }));
  await expect.element(page.getByRole("dialog", { name: "Commit changes" })).toBeVisible();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.scopes = new Set([AuthSourceControlWriteScope]);
  state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
  state.shell = { branch: "main" };
  state.detail = null;
  state.draft = null;
  state.branch = "main";
  state.isDefaultRef = false;
  state.actions = [];
  state.metadataRequests = [];
  state.toasts = [];
  state.afterGitAction = undefined;
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  useComposerDraftStore.setState({
    getDraftSession: () => state.draft as never,
    getDraftThreadByRef: () => state.draft as never,
    setDraftThreadContext: (_target, input) => {
      if (state.draft && input.branch) state.draft = { ...state.draft, branch: input.branch };
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it.each(["direct", "workspace picker"])(
  "opens Git actions from a closed workspace card via %s and keeps its commit dialog mounted",
  async (entry) => {
    function ClosedWorkspace() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [handle] = useState(PopoverCreateHandle);
      const [workspaceActionsOpen, setWorkspaceActionsOpen] = useState(
        entry === "workspace picker",
      );
      return (
        <>
          <PopoverTrigger handle={handle} render={<button ref={anchor}>Workspace</button>} />
          {workspaceActionsOpen ? (
            <WorkbenchCommandPicker
              title="Workspace actions"
              onClose={() => setWorkspaceActionsOpen(false)}
              commands={[
                {
                  id: "git-actions",
                  label: "Git actions: commit, push and pull requests",
                  run: () => {
                    dispatchKeyboardCommand("git.actions");
                  },
                },
              ]}
            />
          ) : null}
          <ThreadDetailsPanel
            anchor={anchor}
            handle={handle}
            onPresentationChange={() => {}}
            environmentId={EnvironmentId.make("environment")}
            threadId={ThreadId.make("thread")}
            activeProjectName="Project"
            activeProjectScripts={undefined}
            preferredScriptId={null}
            keybindings={[]}
            availableEditors={[]}
            showOpenInPicker={false}
            gitCwd="/repo"
            isGitRepo
            envLocked={false}
            availableEnvironments={[]}
            onEnvironmentChange={() => {}}
            onEnvModeChange={() => {}}
            envMode="local"
            startFromOrigin={false}
            onStartFromOriginChange={() => {}}
            onComposerFocusRequest={() => {}}
            onRunProjectScript={() => {}}
            onAddProjectScript={async () => {
              throw new Error("Unexpected script mutation");
            }}
            onUpdateProjectScript={async () => {
              throw new Error("Unexpected script mutation");
            }}
            onDeleteProjectScript={async () => {
              throw new Error("Unexpected script mutation");
            }}
          />
        </>
      );
    }
    await act(() =>
      root.render(
        <StrictMode>
          <ClosedWorkspace />
        </StrictMode>,
      ),
    );
    expect(document.querySelector("[data-thread-details-card]")).toBeNull();
    if (entry === "workspace picker") {
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Search workspace actions"),
      );
      await act(async () => {
        await userEvent.keyboard("{Enter}");
      });
    } else await act(() => expect(dispatchKeyboardCommand("git.actions")).toBe(true));
    await expect
      .element(page.getByRole("dialog", { name: "Git actions", exact: true }))
      .toBeVisible();
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Search git actions"),
    );
    expect(document.querySelector("[data-thread-details-card]")).not.toBeNull();
    await act(async () => {
      await userEvent.keyboard("Commit{Enter}");
    });
    await expect.element(page.getByRole("dialog", { name: "Commit changes" })).toBeVisible();
    expect(document.querySelector("[data-thread-details-card]")).not.toBeNull();
    expect(commits()).toBe(0);
  },
);

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
});

describe("Git actions while thread details load", () => {
  it("does not offer a feature branch for a server thread without task permission", async () => {
    await render();
    await openCommitDialog();

    // The primary environment's task grant must not leak into this thread's environment.
    await expect.element(button("Commit on new branch")).toBeDisabled();
    expect(commits()).toBe(0);
  });

  it("checks the task grant again when the feature-branch commit runs", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    await render();
    await openCommitDialog();
    state.scopes.delete(AuthOrchestrationOperateScope);

    await userEvent.click(button("Commit on new branch"));

    expect(commits()).toBe(0);
    expect(state.branch).toBe("main");
    expect(state.shell?.branch).toBe("main");
  });

  it("commits and synchronizes the server thread before details finish loading", async () => {
    state.primaryScopes.clear();
    state.scopes.add(AuthOrchestrationOperateScope);
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));

    await vi.waitFor(() => expect(state.shell?.branch).toBe("feature"));
    expect(commits()).toBe(1);
    expect(state.actions[0]?.input).toMatchObject({ action: "commit", featureBranch: true });
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("synchronizes archived thread detail after its shell disappears", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "main" };
    await render();
    state.shell = null;
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));

    await vi.waitFor(() => expect(state.detail?.branch).toBe("feature"));
    expect(commits()).toBe(1);
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("requires task permission before changing an archived thread's branch", async () => {
    state.shell = null;
    state.detail = { branch: "main" };
    await render();
    await openCommitDialog();

    await expect.element(button("Commit on new branch")).toBeDisabled();
    expect(state.metadataRequests).toEqual([]);
  });

  it("uses the current shell branch when cached detail names the new branch", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "feature" };
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));

    await vi.waitFor(() => expect(state.shell?.branch).toBe("feature"));
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it.each([
    [AuthOrchestrationOperateScope, false],
    [AuthSourceControlWriteScope, true],
  ] as const)(
    "uses the fresh task grant after Git finishes, revoking %s",
    async (revokedScope, syncsThread) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(revokedScope);
      await render();
      await openCommitDialog();
      await userEvent.click(button("Commit on new branch"));

      await vi.waitFor(() => expect(state.branch).toBe("feature"));
      expect(commits()).toBe(1);
      expect(state.shell?.branch).toBe(syncsThread ? "feature" : "main");
      expect(state.metadataRequests).toHaveLength(syncsThread ? 1 : 0);
    },
  );

  it("keeps ordinary commits available while details load", async () => {
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit"));

    await vi.waitFor(() => expect(commits()).toBe(1));
    expect(state.actions[0]?.input).not.toHaveProperty("featureBranch");
    expect(state.branch).toBe("main");
  });

  it("keeps feature-branch commits available for a local draft", async () => {
    state.shell = null;
    state.draft = { branch: "main", worktreePath: null, envMode: "local" };
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));

    await vi.waitFor(() => expect(state.draft?.branch).toBe("feature"));
    expect(commits()).toBe(1);
    expect(state.metadataRequests).toEqual([]);
  });
});

describe("Default branch prompt", () => {
  beforeEach(() => {
    state.isDefaultRef = true;
    state.scopes.add(AuthOrchestrationOperateScope);
  });

  it("moves the commit to a feature branch when asked", async () => {
    await render();
    await userEvent.click(button(/^Commit & push/));
    await expect
      .element(page.getByRole("dialog", { name: "Commit & push to default ref?" }))
      .toBeVisible();
    expect(commits()).toBe(0);

    await userEvent.click(button("Check out feature branch & continue"));

    await vi.waitFor(() => expect(state.shell?.branch).toBe("feature"));
    expect(state.actions[0]?.input).toMatchObject({ action: "commit_push", featureBranch: true });
  });

  it("checks the task grant again when the feature branch is chosen", async () => {
    await render();
    await userEvent.click(button(/^Commit & push/));
    await expect
      .element(page.getByRole("dialog", { name: "Commit & push to default ref?" }))
      .toBeVisible();
    state.scopes.delete(AuthOrchestrationOperateScope);

    await userEvent.click(button("Check out feature branch & continue"));

    expect(commits()).toBe(0);
    expect(state.shell?.branch).toBe("main");
  });
});

describe("Git action targets across thread navigation", () => {
  const quickAction = () => button(/^Commit, push & /);

  it("runs a retained PR toast in the thread that produced it", async () => {
    await render("first", "/first");
    await userEvent.click(quickAction());
    await vi.waitFor(() => expect(state.toasts.some((toast) => toast.actionProps)).toBe(true));
    const toast = state.toasts.find((toast) => toast.actionProps)!;

    await render("second", "/second");
    await act(async () => toast.actionProps!.onClick());

    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });

  it("runs the memoized button in the current thread after navigation", async () => {
    for (const [thread, cwd] of [
      ["first", "/first"],
      ["second", "/second"],
      ["first", "/first"],
    ] as const) {
      await render(thread, cwd);
      await userEvent.click(quickAction());
      await vi.waitFor(() =>
        expect(state.actions.at(-1)).toMatchObject({ scope: { cwd }, input: { threadId: thread } }),
      );
    }
    expect(commits()).toBe(3);
  });
});
