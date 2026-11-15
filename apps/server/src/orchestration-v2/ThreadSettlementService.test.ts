import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as ByteSize from "effect/ByteSize";
import * as Option from "effect/Option";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  MessageId,
  EventId,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  RunId,
  type OrchestrationV2Run,
  ThreadId,
  TurnItemId,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type PullRequestSummary,
  type ServerSettings as ContractServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as GitManager from "../git/GitManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

type SettlementShell = OrchestrationV2ThreadShell &
  Pick<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">;

function shell(overrides: Partial<SettlementShell> = {}): SettlementShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: overrides.latestUserMessageAt ?? null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function persistedLink(
  state: "open" | null,
  linkedAt: DateTime.Utc,
): NonNullable<SettlementShell["pullRequests"]>[number] {
  return {
    host: "example.test",
    repository: "owner/repository",
    number: 42,
    url: "https://example.test/owner/repository/pull/42",
    source: "manual",
    linkedAt: DateTime.formatIso(linkedAt),
    snapshot:
      state === null
        ? null
        : {
            state,
            title: "Pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: DateTime.formatIso(linkedAt),
            syncedAt: DateTime.formatIso(linkedAt),
          },
    stack: null,
  };
}

describe("isAutoSettlementCandidate", () => {
  it("settles a thread whose only background work is a command left running", () => {
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "dev", kind: "command", description: "vp run dev --share" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(true);
    // A pull request watch whose checks finished holds nothing, yet still keeps the thread.
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "pull-request-watch:github.com/acme/app#1", kind: "monitor" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("never settles, or keeps snoozed, a thread whose guest is waiting on the owner", () => {
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ pendingGuestMessageCount: 1 }),
        NOW_MS,
      ),
    ).toBe(false);
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
      pendingGuestMessageCount: 1,
    });
    expect(ThreadSettlementService.isSnoozed(snoozed, NOW_MS)).toBe(false);
  });

  it("keeps snoozed threads parked until a fresh failure or timer wake", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(ThreadSettlementService.isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    const failed = shell({
      ...snoozed,
      status: "failed",
      latestRunCompletedAt: at(-30 * 60 * 1_000),
    });
    expect(ThreadSettlementService.isSnoozed(failed, NOW_MS)).toBe(false);
    expect(ThreadSettlementService.isAutoSettlementCandidate(failed, NOW_MS)).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-2 * 60 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: snoozed.snoozedAt }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: null }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, snoozedUntil: at(-1) }),
        NOW_MS,
      ),
    ).toBe(true);
  });
});

describe("resolveAutoSettlementAt", () => {
  it.each(["merged", "closed", "inactivity"] as const)(
    "keeps a failed run visible instead of settling on %s",
    (reason) => {
      const input = {
        thread: shell({ status: "failed", latestRunCompletedAt: at(-4 * DAY_MS) }),
        pullRequest:
          reason === "inactivity"
            ? null
            : {
                state: reason,
                mergedAt: DateTime.formatIso(at(-1)),
                closedAt: DateTime.formatIso(at(-1)),
              },
        nowMs: NOW_MS,
        autoSettleAfterDays: reason === "inactivity" ? 3 : null,
        autoSettleOnMerge: true,
      };
      expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
      expect(
        ThreadSettlementService.resolveAutoSettlementAt({
          ...input,
          thread: { ...input.thread, status: "completed" },
        }),
      ).toEqual(at(-4 * DAY_MS));
    },
  );

  it("keeps threads with a PR from inactivity settlement only when asked", () => {
    const input = {
      thread: shell({
        latestUserMessageAt: at(-4 * DAY_MS),
        linkedPullRequest: {
          projectId: ProjectId.make("project-1"),
          repository: "owner/repo",
          number: 1,
          url: "https://example.test/owner/repo/pull/1",
        },
      }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      autoSettleKeepPullRequests: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        autoSettleKeepPullRequests: false,
      }),
    ).toEqual(at(-4 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-1)) },
      }),
    ).toEqual(at(-4 * DAY_MS));
  });

  it("settles an idle thread with an open persisted link only while retention is off", () => {
    const input = {
      thread: shell({
        latestUserMessageAt: at(-4 * DAY_MS),
        pullRequests: [persistedLink("open", at(-5 * DAY_MS))],
      }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      autoSettleKeepPullRequests: false,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-4 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        autoSettleKeepPullRequests: true,
      }),
    ).toBeNull();
    // The open link outranks a merged lookup, so only inactivity can settle it.
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-1)) },
        autoSettleAfterDays: null,
      }),
    ).toBeNull();
  });

  it("keeps an idle thread whose persisted link was never synced", () => {
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        thread: shell({
          latestUserMessageAt: at(-4 * DAY_MS),
          pullRequests: [persistedLink(null, at(-5 * DAY_MS))],
        }),
        pullRequest: null,
        nowMs: NOW_MS,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: true,
        autoSettleKeepPullRequests: false,
      }),
    ).toBeNull();
  });

  it("uses the latest activity time when the inactivity window elapses", () => {
    const idle = shell({
      latestUserMessageAt: at(-4 * DAY_MS),
      latestRunRequestedAt: at(-4 * DAY_MS),
      latestRunStartedAt: at(-4 * DAY_MS),
      latestRunCompletedAt: at(-3 * DAY_MS),
    });
    const input = {
      thread: idle,
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-3 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: 5 }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null }),
    ).toBeNull();
  });

  it("anchors an empty thread's inactivity at its creation time", () => {
    const input = {
      thread: shell({ createdAt: at(-3 * DAY_MS) }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: false,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-3 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: shell({ createdAt: at(-DAY_MS) }),
      }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: { ...input.thread, lastSnoozeWakeAt: at(-DAY_MS) },
      }),
    ).toBeNull();
  });

  it.each(["manual", "timer"])("restarts inactivity on a %s snooze wake", (wake) => {
    const thread = {
      ...shell({ latestRunCompletedAt: at(-4 * DAY_MS) }),
      ...(wake === "manual"
        ? { lastSnoozeWakeAt: at(-1_000) }
        : { snoozedAt: at(-3 * DAY_MS), snoozedUntil: at(-1_000) }),
    };
    const input = {
      thread,
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 1,
      autoSettleOnMerge: false,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, nowMs: NOW_MS + DAY_MS }),
    ).toEqual(at(-1_000));
  });

  it("settles on merge only after the user's last action and preserves the activity time", () => {
    const thread = shell({
      latestUserMessageAt: at(-2 * 60 * 60 * 1_000),
      latestRunCompletedAt: at(-90 * 60 * 1_000),
    });
    const input = {
      thread,
      pullRequest: {
        state: "merged" as const,
        mergedAt: DateTime.formatIso(at(-60 * 60 * 1_000)),
      },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-90 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleOnMerge: false }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-3 * 60 * 60 * 1_000)) },
      }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: shell(),
        pullRequest: { state: "closed", closedAt: DateTime.formatIso(at(-1)) },
        autoSettleOnMerge: false,
      }),
    ).toEqual(shell().createdAt);
  });

  it("settles on merge after agent-started runs, but not after the user writes again", () => {
    const woken = shell({
      latestUserMessageAt: at(-30 * 60 * 1_000),
      latestUserAuthoredMessageAt: at(-2 * 60 * 60 * 1_000),
      latestRunRequestedAt: at(-30 * 60 * 1_000),
      latestRunCompletedAt: at(-29 * 60 * 1_000),
    });
    const input = {
      thread: woken,
      pullRequest: { state: "merged" as const, mergedAt: DateTime.formatIso(at(-60 * 60 * 1_000)) },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-29 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: { ...woken, latestUserAuthoredMessageAt: at(-30 * 60 * 1_000) },
      }),
    ).toBeNull();
  });

  it("does not settle on pull requests that were already merged when linked", () => {
    const link = (number: number, linkedAt: DateTime.Utc, mergedAt: DateTime.Utc) => ({
      host: "example.test",
      repository: "owner/repository",
      number,
      url: `https://example.test/owner/repository/pull/${number}`,
      source: "agent" as const,
      linkedAt: DateTime.formatIso(linkedAt),
      snapshot: {
        state: "merged" as const,
        title: "Pull request",
        headBranch: `feature-${number}`,
        baseBranch: "main",
        isDraft: false,
        updatedAt: DateTime.formatIso(mergedAt),
        syncedAt: DateTime.formatIso(linkedAt),
        mergedAt: DateTime.formatIso(mergedAt),
      },
      stack: null,
    });
    const recorded = link(1, at(-50 * 60 * 1_000), at(-55 * 60 * 1_000));
    const input = {
      thread: shell({
        latestUserMessageAt: at(-2 * 60 * 60 * 1_000),
        latestRunCompletedAt: at(-45 * 60 * 1_000),
        pullRequests: [recorded],
      }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: {
          ...input.thread,
          pullRequests: [recorded, link(2, at(-90 * 60 * 1_000), at(-40 * 60 * 1_000))],
        },
      }),
    ).toEqual(at(-45 * 60 * 1_000));
  });
});

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");

describe("autoSettlementSettingsKey", () => {
  it("distinguishes a project that inherits the threshold from one that disables it", () => {
    const inherits = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: true } },
    });
    const never = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: null },
      },
    });
    assert.notStrictEqual(inherits, never);
  });
});

type AutoSettleCommand = Extract<OrchestrationV2Command, { readonly type: "thread.auto-settle" }>;

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(1));

function makeProject(
  id: ProjectId = PROJECT_ID,
  workspaceRoot = "/workspace/project",
): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(id: string, overrides: Partial<SettlementShell> = {}): SettlementShell {
  return shell({
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    latestUserMessageAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    ...overrides,
  });
}

type SettlementSnapshot = Omit<OrchestrationV2ShellSnapshot, "threads"> & {
  readonly threads: ReadonlyArray<SettlementShell>;
};

function makeSnapshot(
  threads: ReadonlyArray<SettlementShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): SettlementSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects,
    threads,
    archivedThreads: [],
  };
}

function makePullRequestSummary(input: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: string;
}): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://example.test/${input.repository}/pull/${input.number}`,
    state: input.state,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: input.updatedAt ?? NOW,
  };
}

function makeBranchPullRequest(state: "open" | "closed" | "merged") {
  return {
    number: 42,
    title: "Pull request",
    url: "https://example.test/owner/repository/pull/42",
    baseRef: "main",
    headRef: "feature",
    state,
    repositoryKey: "example.test/owner/repository",
    updatedAt: NOW,
    closedAt: state === "closed" ? NOW : null,
    mergedAt: state === "merged" ? NOW : null,
  } satisfies GitManager.GitBranchPullRequest;
}

// GitManager rereads git state on request, and by default whenever its
// remembered answer is merged or closed.
function readsFreshGitState(
  options: Parameters<GitManager.GitManager["Service"]["branchPullRequest"]>[1],
): boolean {
  return (
    options?.refresh === true ||
    options?.freshGitState === true ||
    options?.confirmTerminal !== false
  );
}

interface HarnessOptions {
  readonly snapshot: SettlementSnapshot;
  readonly settings?: ContractServerSettings;
  readonly branchPullRequest?: GitManager.GitManager["Service"]["branchPullRequest"];
  readonly pullRequestSummary?: PullRequestService.PullRequestService["Service"]["summary"];
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly gitDirectories?: ReadonlyArray<string>;
  readonly gitFiles?: ReadonlyArray<string>;
  readonly unreadablePaths?: ReadonlyArray<string>;
  readonly onDispatch?: (command: AutoSettleCommand) => Effect.Effect<void>;
  readonly onScriptRun?: (
    input: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<void>;
  readonly onCloseIdle?: () => Effect.Effect<void>;
  readonly onRealPath?: (path: string) => Effect.Effect<void>;
  readonly realWorktreePaths?: Readonly<Record<string, string>>;
  readonly runnerReceiptNames?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly onRunnerRead?: (path: string) => Effect.Effect<void>;
  readonly currentThreads?: ReadonlyArray<OrchestrationV2AppThread>;
  readonly projections?: ProjectionStore.ProjectionStoreV2Shape;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const candidateReads = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsReadCount = yield* Ref.make(0);
  const settingsChanges = yield* PubSub.unbounded<ContractServerSettings>();
  const mergedPullRequests = yield* PubSub.unbounded<PullRequestService.PullRequestMergeEvent>();
  const pullRequestRefreshes = yield* PubSub.unbounded<number>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const branchCalls = yield* Ref.make<
    ReadonlyArray<{ readonly cwd: string; readonly branch: string }>
  >([]);
  const summaryCalls = yield* Ref.make<
    ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }>
  >([]);
  const summaryRecovery = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
  const invalidatedCwds = yield* Ref.make<ReadonlyArray<string>>([]);
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const domainEventSubscription = yield* PubSub.subscribe(domainEvents);
  const observedEvents = yield* Queue.unbounded<EventId>();

  const closedIdle = yield* Queue.unbounded<{ readonly threadId: string }>();
  const scriptRuns =
    yield* Queue.unbounded<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput>();

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const branchPullRequest: GitManager.GitManager["Service"]["branchPullRequest"] = (
    input,
    lookupOptions,
  ) =>
    Ref.update(branchCalls, (calls) => [...calls, input]).pipe(
      Effect.andThen(options.branchPullRequest?.(input, lookupOptions) ?? Effect.succeed(null)),
    );
  const pullRequestSummary: PullRequestService.PullRequestService["Service"]["summary"] = (
    input,
    readOptions,
  ) =>
    Effect.gen(function* () {
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      yield* Ref.update(summaryRecovery, (values) => [
        ...values,
        readOptions?.recoverTransientFailure,
      ]);
      return yield* (
        options.pullRequestSummary?.(input, readOptions) ??
          Effect.succeed(
            makePullRequestSummary({
              ...input,
              state: "open",
            }),
          )
      );
    });

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  };

  const serverSettings = ServerSettings.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.update(settingsReadCount, (count) => count + 1).pipe(
      Effect.andThen(Ref.get(settings)),
    ),
    updateSettings,
    updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
    withSettingsSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Ref.get(snapshots).pipe(Effect.map((snapshot) => snapshot.projects)),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: (query) =>
        Ref.get(snapshots).pipe(
          Effect.map((snapshot) => {
            const threads = new Map(
              (options.currentThreads ?? []).map((thread) => [
                thread.id,
                { ...shell(), ...thread },
              ]),
            );
            for (const thread of snapshot.threads)
              threads.set(thread.id, { ...thread, lastVisitedAt: thread.lastVisitedAt ?? null });
            const visible = [...threads.values()].filter(
              (thread) =>
                (query?.projectId === undefined || thread.projectId === query.projectId) &&
                (query?.location === "archive"
                  ? thread.archivedAt !== null
                  : thread.archivedAt === null),
            );
            return {
              schemaVersion: 1 as const,
              snapshotSequence: 1,
              archivedThreads: visible.filter((thread) => thread.archivedAt !== null),
              threads: visible.filter((thread) => thread.archivedAt === null),
            };
          }),
        ),
      ...options.projections,

      getSettlementCandidates: (threadId) =>
        Ref.update(candidateReads, (reads) => [...reads, threadId]).pipe(
          Effect.andThen(Ref.updateAndGet(snapshotReadCount, (count) => count + 1)),
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(
            options.projections?.getSettlementCandidates(threadId) ??
              Ref.get(snapshots).pipe(
                Effect.map((snapshot) =>
                  threadId === undefined
                    ? snapshot.threads
                    : snapshot.threads.filter((thread) => thread.id === threadId),
                ),
              ),
          ),
        ),
      getThreadWorktreePaths: () =>
        Effect.sync(() =>
          (options.currentThreads ?? []).flatMap((thread) =>
            thread.worktreePath === null
              ? []
              : [{ threadId: thread.id, worktreePath: thread.worktreePath }],
          ),
        ),
      getThreadShell: (threadId) =>
        Ref.get(snapshots).pipe(
          Effect.map((snapshot) => {
            const live = snapshot.threads.find((thread) => thread.id === threadId);
            if (live) return live;
            const current = options.currentThreads?.find((thread) => thread.id === threadId);
            return current ? { ...shell(), ...current } : null;
          }),
        ),

      getThread: (threadId) => {
        if (options.projections) return options.projections.getThread(threadId);
        const thread = options.currentThreads?.find((candidate) => candidate.id === threadId);
        return thread
          ? Effect.succeed(thread)
          : Effect.die(new Error(`Unexpected thread read: ${threadId}`));
      },
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromSubscription(domainEventSubscription).pipe(
        Stream.tap((event) => Queue.offer(observedEvents, event.id)),
      ),

      dispatch,
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      closeIdle: () => options.onCloseIdle?.() ?? Effect.void,
      closeOnSettle: (input) =>
        Queue.offer(closedIdle, input).pipe(Effect.andThen(options.onCloseIdle?.() ?? Effect.void)),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: (input) =>
        Queue.offer(scriptRuns, input).pipe(
          Effect.andThen(options.onScriptRun?.(input) ?? Effect.void),
          Effect.as({ status: "no-script" } as const),
        ),
    }),
    Layer.mock(GitManager.GitManager)({
      branchPullRequest,
      invalidateStatus: (cwd) => Ref.update(invalidatedCwds, (cwds) => [...cwds, cwd]),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      summary: pullRequestSummary,
      subscribeMerges: PubSub.subscribe(mergedPullRequests).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      subscribeRefreshes: Stream.fromPubSub(pullRequestRefreshes),
    }),
    Layer.succeed(ServerSettings.ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
    FileSystem.layerNoop({
      exists: (path) =>
        options.unreadablePaths?.includes(path)
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "exists",
                pathOrDescriptor: path,
              }),
            )
          : Effect.succeed(
              (options.existingWorktreePaths?.includes(path) ?? false) ||
                (options.gitDirectories?.includes(path) ?? false) ||
                (options.gitFiles?.includes(path) ?? false),
            ),
      stat: (path) =>
        Effect.succeed({
          type: options.gitFiles?.includes(path) ? ("File" as const) : ("Directory" as const),
          mtime: Option.none(),
          atime: Option.none(),
          birthtime: Option.none(),
          dev: 0n,
          ino: Option.none(),
          mode: 0o700,
          nlink: Option.some(1n),
          uid: Option.none(),
          gid: Option.none(),
          rdev: Option.none(),
          size: ByteSize.zero,
          blksize: Option.none(),
          blocks: Option.none(),
        }),
      readFileString: (path) =>
        options.gitFiles?.includes(path)
          ? Effect.succeed("gitdir: /repo/.git/worktrees/task\n")
          : Effect.die("Unexpected file read"),
      realPath: (path) =>
        (options.onRealPath?.(path) ?? Effect.void).pipe(
          Effect.as(options.realWorktreePaths?.[path] ?? path),
        ),
      readDirectory: (path) =>
        (options.onRunnerRead?.(path) ?? Effect.void).pipe(
          Effect.as([...(options.runnerReceiptNames?.[path] ?? [])]),
        ),
    }),
    Path.layer,
  );

  return {
    activation,
    settings,
    snapshots,
    snapshotReadCount,
    settingsReadCount,
    snapshotReads,
    candidateReads,
    commands,
    branchCalls,
    summaryCalls,
    summaryRecovery,
    invalidatedCwds,
    closedIdle,
    scriptRuns,
    observedEvents,
    publishEvent: (event: OrchestrationV2DomainEvent) => PubSub.publish(domainEvents, event),
    updateSettings,
    publishRefresh: PubSub.publish(pullRequestRefreshes, 1),
    publishMerge: PubSub.publish(mergedPullRequests, {
      projectId: PROJECT_ID,
      repository: "owner/repository",
      number: 42,
      mergedAt: NOW,
    }),
    layer: Layer.effect(
      ThreadSettlementService.ThreadSettlementServiceV2,
      ThreadSettlementService.make,
    ).pipe(Layer.provide(layerDependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementService.ThreadSettlementServiceV2["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

const projectionStoreSql = ProjectionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const appThread = (
  id: string,
  settledOverride: OrchestrationV2AppThread["settledOverride"],
  worktreePath: string | null = null,
): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride,
    settledAt: settledOverride === "settled" ? DateTime.makeUnsafe(NOW) : null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};
const settledEvent = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
  type: "thread.settled",
  id: EventId.make(`event:settled:${thread.id}`),
  threadId: thread.id,
  occurredAt: DateTime.makeUnsafe(NOW),
  payload: thread,
});

describe("ThreadSettlementServiceV2 worker", () => {
  it.effect("skips settings and PR decisions for recent branchless threads", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const threads = Array.from({ length: 32 }, (_, index) =>
        makeThread(`recent-${index}`, {
          updatedAt: DateTime.makeUnsafe(NOW),
          latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS),
        }),
      );
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot(threads),
        settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
        assert.deepEqual(yield* Ref.get(fixture.branchCalls), []);
        assert.equal(yield* Ref.get(fixture.settingsReadCount), 2);
        yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
        yield* Queue.take(fixture.snapshotReads);
        yield* service.drain;
        assert.deepEqual(
          new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
          new Set(threads.map((thread) => thread.id)),
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
  it.effect("only settles a merged pull request when the latest run has not failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("merged-link", {
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          pullRequests: [
            {
              host: "example.test",
              repository: "owner/repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
              source: "manual",
              linkedAt: "2026-08-20T00:00:00.000Z",
              snapshot: {
                state: "merged",
                title: "Pull request",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: NOW,
                syncedAt: NOW,
                mergedAt: NOW,
              },
              stack: null,
            },
          ],
        });
        const failedThread = shell({
          ...thread,
          id: ThreadId.make("failed-after-merge"),
          status: "failed",
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread, failedThread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            thread.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles a merged pull request stored only in the thread links", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const thread = makeThread("merged-link", {
        pullRequests: [
          {
            host: "example.test",
            repository: "owner/repository",
            number: 42,
            url: "https://example.test/owner/repository/pull/42",
            source: "manual",
            linkedAt: "2026-08-20T00:00:00.000Z",
            snapshot: {
              state: "merged",
              title: "Pull request",
              headBranch: "feature",
              baseBranch: "main",
              isDraft: false,
              updatedAt: NOW,
              syncedAt: NOW,
              mergedAt: NOW,
            },
            stack: null,
          },
        ],
      });
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([thread]),
        settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
          thread.id,
        ]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("settles an idle thread with an open persisted link on the inactivity sweep", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const thread = makeThread("open-link", {
        pullRequests: [persistedLink("open", DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"))],
      });
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([thread]),
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          sidebarAutoSettleAfterDays: 3,
          sidebarAutoSettleKeepPullRequests: false,
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
          thread.id,
        ]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("settles only the project opted in while environment settlement is disabled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const thread = makeThread("project-opt-in", {
        latestRunCompletedAt: DateTime.makeUnsafe("2026-08-25T00:00:00.000Z"),
      });
      const other = makeThread("environment-off", { projectId: ProjectId.make("other-project") });
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([thread, other]),
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
          projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleAfterDays: 2 } },
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        const commands = yield* Ref.get(fixture.commands);
        expect(commands.map((command) => command.threadId)).toEqual([thread.id]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("stops settling the rest of a sweep once auto-settlement is turned off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      // Sweeps settle 8 threads at a time, so the ninth starts after a dispatch turned it off.
      const threads = Array.from({ length: 9 }, (_, index) => makeThread(`idle-${index}`));
      let disable: Effect.Effect<unknown> = Effect.void;
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot(threads),
        settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
        onDispatch: () => disable,
      });
      disable = fixture.updateSettings({ sidebarAutoSettleAfterDays: null });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        const settled = (yield* Ref.get(fixture.commands)).map((command) => command.threadId);
        expect(settled).not.toContain(threads[8]!.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect(
    "drains idle subagents of a settled parent and retries busy children without PR lookups",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const parent = appThread("subagent-parent", "settled");
        const child = (id: string, overrides: Partial<OrchestrationV2AppThread> = {}) => ({
          ...appThread(id, null),
          branch: "feature",
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "subagent" as const,
          },
          ...overrides,
        });
        const empty = child("empty");
        const recent = child("recent");
        const busy = child("busy");
        const marker = appThread("marker", "settled");
        for (const thread of [
          parent,
          empty,
          recent,
          busy,
          marker,
          child("pinned", { pinnedAt: DateTime.makeUnsafe(NOW) }),
          child("opted-out", { autoSettleDisabledAt: DateTime.makeUnsafe(NOW) }),
        ]) {
          yield* store.apply({
            type: "thread.created",
            id: EventId.make(`created:${thread.id}`),
            threadId: thread.id,
            occurredAt: thread.createdAt,
            payload: thread,
          });
        }
        const run = (threadId: ThreadId, status: "running" | "completed"): OrchestrationV2Run => ({
          id: RunId.make(`run:${threadId}`),
          threadId,
          ordinal: 1,
          providerInstanceId: parent.providerInstanceId,
          modelSelection: parent.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:${threadId}`),
          rootNodeId: null,
          activeAttemptId: null,
          status,
          requestedAt: DateTime.makeUnsafe(NOW),
          startedAt: DateTime.makeUnsafe(NOW),
          completedAt: status === "completed" ? DateTime.makeUnsafe(NOW) : null,
          checkpointId: null,
          contextHandoffId: null,
        });
        for (const payload of [run(recent.id, "completed"), run(busy.id, "running")]) {
          yield* store.apply({
            type: "run.created",
            id: EventId.make(`created:${payload.id}`),
            threadId: payload.threadId,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload,
          });
        }
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          projections: store,
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 },
          onDispatch: (command) =>
            store.getThread(command.threadId).pipe(
              Effect.flatMap((thread) =>
                store.apply(
                  settledEvent({
                    ...thread,
                    settledOverride: "settled",
                    settledAt: DateTime.makeUnsafe(NOW),
                  }),
                ),
              ),
              Effect.orDie,
            ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const commands = yield* Ref.get(fixture.commands);
          expect(commands.map((command) => command.threadId).toSorted()).toEqual([
            empty.id,
            recent.id,
          ]);
          for (const command of commands) {
            expect(command.snapshotAt).toEqual(DateTime.makeUnsafe(NOW));
            expect(command.settledAt).toBeUndefined();
          }
          const finished: OrchestrationV2DomainEvent = {
            type: "run.updated",
            id: EventId.make("busy:completed"),
            threadId: busy.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: run(busy.id, "completed"),
          };
          yield* store.apply(finished);
          yield* fixture.publishEvent(finished);
          // Cleanup of the following event marks delivery of the run event before draining.
          yield* fixture.publishEvent(settledEvent(marker));
          expect(yield* Queue.take(fixture.closedIdle)).toEqual({ threadId: marker.id });
          yield* service.drain;
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            empty.id,
            recent.id,
            busy.id,
          ]);
          expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
          expect(yield* Ref.get(fixture.summaryCalls)).toEqual([]);
        }).pipe(Effect.provide(fixture.layer));
      }).pipe(Effect.provide(projectionStoreSql)),
  );

  it.effect(
    "manual parent settlement drains hidden children with automatic settlement disabled",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const parent = appThread("manual-parent", null);
        const child = {
          ...appThread("manual-child", null),
          branch: "feature",
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "subagent" as const,
          },
        };
        const marker = appThread("marker", "settled");
        for (const thread of [parent, child, marker]) {
          yield* store.apply({
            type: "thread.created",
            id: EventId.make(`created:${thread.id}`),
            threadId: thread.id,
            occurredAt: thread.createdAt,
            payload: thread,
          });
        }
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          projections: store,
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 },
          onDispatch: (command) =>
            store.getThread(command.threadId).pipe(
              Effect.flatMap((thread) =>
                store.apply(
                  settledEvent({
                    ...thread,
                    settledOverride: "settled",
                    settledAt: DateTime.makeUnsafe(NOW),
                  }),
                ),
              ),
              Effect.orDie,
            ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
          // Avoid a settings-change sweep: the parent event must trigger the child dispatch.
          yield* Ref.set(fixture.settings, {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
          });
          const event = settledEvent({
            ...parent,
            settledOverride: "settled",
            settledAt: DateTime.makeUnsafe(NOW),
          });
          yield* store.apply(event);
          yield* fixture.publishEvent(event);
          yield* fixture.publishEvent(settledEvent(marker));
          expect(yield* Queue.take(fixture.closedIdle)).toEqual({ threadId: parent.id });
          expect(yield* Queue.take(fixture.closedIdle)).toEqual({ threadId: marker.id });
          yield* service.drain;
          expect(yield* Ref.get(fixture.commands)).toEqual([
            expect.objectContaining({
              type: "thread.auto-settle",
              threadId: child.id,
              snapshotAt: child.updatedAt,
            }),
          ]);
          expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
          expect(yield* Ref.get(fixture.summaryCalls)).toEqual([]);
        }).pipe(Effect.provide(fixture.layer));
      }).pipe(Effect.provide(projectionStoreSql)),
  );

  it.effect(
    "coalesces bulk cleanup wakes and still drains children discovered during a sweep",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sweepStarted = yield* Deferred.make<void>();
        const releaseSweep = yield* Deferred.make<void>();
        const childSettled = yield* Deferred.make<void>();
        const parent = appThread("bulk-parent", null);
        const child = {
          ...appThread("bulk-child", null),
          lineage: {
            parentThreadId: parent.id,
            rootThreadId: parent.id,
            relationshipToParent: "subagent" as const,
          },
        };
        const marker = appThread("bulk-marker", "settled");
        const parents = [
          parent,
          ...Array.from({ length: 233 }, (_, i) => appThread(`bulk-parent-${i}`, null)),
        ];
        for (const thread of [...parents, child, marker]) {
          yield* store.apply({
            type: "thread.created",
            id: EventId.make(`created:${thread.id}`),
            threadId: thread.id,
            occurredAt: thread.createdAt,
            payload: thread,
          });
        }
        let blockNextSweep = false;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
          },
          projections: {
            ...store,
            getSettlementCandidates: (threadId) =>
              Effect.gen(function* () {
                const candidates = yield* store.getSettlementCandidates(threadId);
                if (blockNextSweep) {
                  blockNextSweep = false;
                  yield* Deferred.succeed(sweepStarted, undefined);
                  yield* Deferred.await(releaseSweep);
                }
                return candidates;
              }),
          },
          onDispatch: (command): Effect.Effect<void> =>
            Effect.gen(function* () {
              const thread = yield* store.getThread(command.threadId);
              const event = settledEvent({
                ...thread,
                settledOverride: "settled",
                settledAt: DateTime.makeUnsafe(NOW),
              });
              yield* store.apply(event);
              yield* fixture.publishEvent(event);
              yield* Deferred.succeed(childSettled, undefined);
            }).pipe(Effect.orDie),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* Ref.set(fixture.candidateReads, []);
          blockNextSweep = true;
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Deferred.await(sweepStarted);

          for (const [i, thread] of parents.entries()) {
            const type = (["thread.settled", "thread.archived", "thread.deleted"] as const)[i % 3]!;
            const event: OrchestrationV2DomainEvent = {
              type,
              id: EventId.make(`bulk:${thread.id}`),
              threadId: thread.id,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: {
                ...thread,
                ...(type === "thread.settled"
                  ? { settledOverride: "settled" as const, settledAt: DateTime.makeUnsafe(NOW) }
                  : type === "thread.archived"
                    ? { archivedAt: DateTime.makeUnsafe(NOW) }
                    : { deletedAt: DateTime.makeUnsafe(NOW) }),
              },
            };
            yield* store.apply(event);
            yield* fixture.publishEvent(event);
          }
          const markDelivery = (id: string) =>
            fixture
              .publishEvent({
                type: "thread.created",
                id: EventId.make(id),
                threadId: marker.id,
                occurredAt: marker.createdAt,
                payload: marker,
              })
              .pipe(
                // The next event is observed only after the previous handler has finished enqueueing.
                Effect.andThen(
                  Queue.take(fixture.observedEvents).pipe(
                    Effect.repeat({ until: (seen) => seen === id }),
                  ),
                ),
              );
          yield* markDelivery("bulk-delivered");
          yield* Deferred.succeed(releaseSweep, undefined);
          yield* Deferred.await(childSettled);
          yield* markDelivery("child-delivered");
          yield* service.drain;

          expect(yield* Ref.get(fixture.candidateReads)).toEqual([undefined, undefined, undefined]);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            child.id,
          ]);
          expect((yield* store.getThread(child.id)).settledOverride).toBe("settled");
          expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
          expect(yield* Ref.get(fixture.summaryCalls)).toEqual([]);
        }).pipe(Effect.provide(fixture.layer));
      }).pipe(Effect.provide(projectionStoreSql)),
  );

  it.effect("looks up a branch in its worktree only while the worktree has .git", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([
          makeThread("linked-worktree", {
            branch: "linked",
            worktreePath: "/worktrees/linked",
            latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
          }),
          // A folder that outlived its .git makes git fail with not_a_repository.
          makeThread("emptied-worktree", {
            branch: "emptied",
            worktreePath: "/worktrees/emptied",
            latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
          }),
        ]),
        existingWorktreePaths: [
          "/worktrees/linked",
          "/worktrees/linked/.git",
          "/worktrees/emptied",
        ],
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        const cwdByBranch = Object.fromEntries(
          (yield* Ref.get(fixture.branchCalls)).map((call) => [call.branch, call.cwd]),
        );
        expect(cwdByBranch).toEqual({
          linked: "/worktrees/linked",
          emptied: "/workspace/project",
        });
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("does not settle a thread whose worktree cannot be checked", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot(
          [
            makeThread("unreadable-worktree", {
              branch: "unreadable",
              worktreePath: "/worktrees/unreadable",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
            // A merged linked pull request still needs the branch recheck before settling.
            makeThread("unreadable-linked-worktree", {
              branch: "feature",
              worktreePath: "/worktrees/unreadable-linked",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 41,
                url: "https://example.test/owner/repository/pull/41",
              },
            }),
            makeThread("readable-worktree", {
              branch: "readable",
              worktreePath: "/worktrees/readable",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
          ],
          [
            {
              ...makeProject(),
              repositoryIdentity: {
                canonicalKey: "example.test/owner/repository",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "https://example.test/owner/repository.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "owner",
                name: "repository",
              },
            },
          ],
        ),
        existingWorktreePaths: ["/worktrees/readable", "/worktrees/readable/.git"],
        unreadablePaths: ["/worktrees/unreadable/.git", "/worktrees/unreadable-linked/.git"],
        pullRequestSummary: (input) =>
          Effect.succeed({
            ...makePullRequestSummary({ ...input, state: "merged" }),
            mergedAt: NOW,
          }),
        branchPullRequest: (input) =>
          input.cwd.startsWith("/worktrees/unreadable")
            ? Effect.die(new Error("git: permission denied"))
            : Effect.succeed(makeBranchPullRequest("merged")),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
          ThreadId.make("readable-worktree"),
        ]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("reevaluates immediately after a pull request merge", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const periodicLookupStarted = yield* Deferred.make<void>();
      const releasePeriodicLookup = yield* Deferred.make<void>();
      const mergedThreadSettled = yield* Deferred.make<void>();
      const branchLookupCount = yield* Ref.make(0);
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([
          makeThread("merged-in-app", {
            latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            linkedPullRequest: {
              projectId: PROJECT_ID,
              repository: "Owner/Repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
            },
          }),
          makeThread("slow-periodic-lookup", {
            branch: "another-feature",
            latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
          }),
        ]),
        branchPullRequest: () =>
          Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.succeed(makeBranchPullRequest("open"))
                : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePeriodicLookup)),
                    Effect.as(makeBranchPullRequest("open")),
                  ),
            ),
          ),
        onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
        yield* Deferred.await(periodicLookupStarted);

        yield* fixture.publishMerge;
        yield* Deferred.await(mergedThreadSettled);

        assert.deepStrictEqual(
          (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
          [ThreadId.make("merged-in-app")],
        );
        yield* Deferred.succeed(releasePeriodicLookup, undefined);
        yield* reactor.drain;
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("settles a merged thread when its background work ends, during a slow full sweep", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const periodicLookupStarted = yield* Deferred.make<void>();
      const releasePeriodicLookup = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const branchLookupCount = yield* Ref.make(0);
      const mergedLink: NonNullable<SettlementShell["pullRequests"]>[number] = {
        ...persistedLink("open", DateTime.makeUnsafe("2026-08-20T00:00:00.000Z")),
        snapshot: {
          state: "merged",
          title: "Pull request",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: NOW,
          syncedAt: NOW,
          mergedAt: NOW,
        },
      };
      const waiting = makeThread("waiting-on-subagent", {
        pullRequests: [mergedLink],
        pendingBackgroundTasks: [{ taskId: "child", kind: "subagent", description: "Review" }],
      });
      const slow = makeThread("slow-periodic-lookup", {
        branch: "another-feature",
        latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
      });
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([waiting, slow]),
        branchPullRequest: () =>
          Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.succeed(makeBranchPullRequest("open"))
                : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePeriodicLookup)),
                    Effect.as(makeBranchPullRequest("open")),
                  ),
            ),
          ),
        onDispatch: () => Deferred.succeed(settled, undefined),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
        yield* Deferred.await(periodicLookupStarted);

        yield* Ref.set(
          fixture.snapshots,
          makeSnapshot([{ ...waiting, pendingBackgroundTasks: [] }, slow]),
        );
        yield* fixture.publishEvent({
          type: "run.background-work-cancelled",
          id: EventId.make("event:background-ended"),
          threadId: waiting.id,
          occurredAt: DateTime.makeUnsafe(NOW),
          payload: { runId: RunId.make("run:waiting"), restartCancelledBackgroundWork: [] },
        });
        yield* Deferred.await(settled);

        assert.deepStrictEqual(
          (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
          [waiting.id],
        );
        yield* Deferred.succeed(releasePeriodicLookup, undefined);
        yield* reactor.drain;
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("settles a stopped thread while another thread's lookup is slow", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const slowLookupStarted = yield* Deferred.make<void>();
      const releaseSlowLookup = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const branchLookupCount = yield* Ref.make(0);
      const recent = DateTime.makeUnsafe("2026-08-27T00:00:00.000Z");
      const slow = makeThread("slow-lookup", { branch: "feature", latestUserMessageAt: recent });
      const merged = makeThread("merged", {
        latestUserMessageAt: recent,
        pullRequests: [
          {
            ...persistedLink("open", recent),
            snapshot: {
              state: "merged",
              title: "Pull request",
              headBranch: "feature",
              baseBranch: "main",
              isDraft: false,
              updatedAt: NOW,
              syncedAt: NOW,
              mergedAt: NOW,
            },
          },
        ],
        pendingBackgroundTasks: [{ taskId: "child", kind: "subagent", description: "Review" }],
      });
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([slow, merged]),
        branchPullRequest: () =>
          Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.succeed(makeBranchPullRequest("open"))
                : Deferred.succeed(slowLookupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseSlowLookup)),
                    Effect.as(makeBranchPullRequest("open")),
                  ),
            ),
          ),
        onDispatch: () => Deferred.succeed(settled, undefined),
      });
      const backgroundEnded = (threadId: ThreadId): OrchestrationV2DomainEvent => ({
        type: "run.background-work-cancelled",
        id: EventId.make(`event:background-ended:${threadId}`),
        threadId,
        occurredAt: DateTime.makeUnsafe(NOW),
        payload: { runId: RunId.make(`run:${threadId}`), restartCancelledBackgroundWork: [] },
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(backgroundEnded(slow.id));
        yield* Deferred.await(slowLookupStarted);
        // More events for the slow thread coalesce into one more pass, not more sweeps.
        for (let index = 0; index < 9; index++) {
          yield* fixture.publishEvent(backgroundEnded(slow.id));
        }

        yield* Ref.set(
          fixture.snapshots,
          makeSnapshot([slow, { ...merged, pendingBackgroundTasks: [] }]),
        );
        yield* fixture.publishEvent(backgroundEnded(merged.id));
        yield* Deferred.await(settled);

        assert.deepStrictEqual(
          (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
          [merged.id],
        );
        yield* Deferred.succeed(releaseSlowLookup, undefined);
        yield* reactor.drain;
        // The startup sweep, the first per-thread sweep, and one coalesced rerun.
        assert.strictEqual(yield* Ref.get(branchLookupCount), 3);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect.each([
    { kind: "an unlinked", linked: false },
    { kind: "a quiet linked", linked: true },
  ])("settles $kind branch thread its agent merged from a shell, past the cache", ({ linked }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const thread = makeThread("shell-merged", {
        branch: "saved-feature",
        latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
        ...(linked
          ? {
              branchPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }
          : {}),
      });
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([thread]),
        // The host already merged it; only a fresh read sees that past the cached open lookup.
        branchPullRequest: (_input, lookupOptions) =>
          Effect.succeed(makeBranchPullRequest(lookupOptions?.refresh ? "merged" : "open")),
        pullRequestSummary: (input, readOptions) =>
          Effect.succeed({
            ...makePullRequestSummary({
              ...input,
              state: readOptions?.bypassCache ? "merged" : "open",
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS)),
            }),
            ...(readOptions?.bypassCache ? { mergedAt: NOW } : {}),
          }),
      });
      const at = DateTime.makeUnsafe(NOW);
      const runId = RunId.make("run:shell-merged");
      const runEnded: OrchestrationV2DomainEvent = {
        type: "run.background-work-cancelled",
        id: EventId.make("event:shell-merged:run-ended"),
        threadId: thread.id,
        occurredAt: at,
        payload: { runId, restartCancelledBackgroundWork: [] },
      };

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(runEnded);
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

        yield* fixture.publishEvent({
          type: "turn-item.updated",
          id: EventId.make("event:shell-merged:command"),
          threadId: thread.id,
          runId,
          occurredAt: at,
          payload: {
            id: TurnItemId.make("item:shell-merged:command"),
            threadId: thread.id,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type: "command_execution",
            input: "gh pr merge 42 --squash",
          },
        });
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
          [thread.id],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect(
    "settles branch threads on a pull request merge without waiting for the next sweep",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<"open" | "merged">("open");
        const mergedThreadSettled = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("branch-thread", {
              branch: "saved-feature",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
          ]),
          branchPullRequest: () => Ref.get(state).pipe(Effect.map(makeBranchPullRequest)),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), []);

          yield* Ref.set(state, "merged");
          yield* fixture.publishMerge;
          yield* Deferred.await(mergedThreadSettled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("branch-thread")],
          );
          assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), ["/workspace/project"]);
          yield* reactor.drain;
        }).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("reads a quiet open branch pull request every 5 minutes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([
          makeThread("active-branch", {
            branch: "feature",
            latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            branchPullRequest: {
              projectId: PROJECT_ID,
              repository: "owner/repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
            },
          }),
        ]),
        pullRequestSummary: (input) =>
          Effect.succeed(
            makePullRequestSummary({
              ...input,
              state: "open",
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS)),
            }),
          ),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);

        for (let minute = 0; minute < 4; minute++) {
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
        }
        assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);

        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);

        // An app merge the host completes later sends only a refresh; reads stay on the minute
        // cadence while the pull request still reads open.
        yield* fixture.publishRefresh;
        for (const expected of [3, 4]) {
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, expected);
        }
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect.each([
    { when: "after", mergeDuringRead: false },
    { when: "during", mergeDuringRead: true },
  ])(
    "a merge $when a quiet pull request's read, while its thread is not a candidate, rereads it next sweep",
    ({ mergeDuringRead }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("busy-branch", {
          branch: "feature",
          latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
          branchPullRequest: {
            projectId: PROJECT_ID,
            repository: "owner/repository",
            number: 42,
            url: "https://example.test/owner/repository/pull/42",
          },
        });
        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        if (!mergeDuringRead) yield* Deferred.succeed(releaseRead, undefined);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          pullRequestSummary: (input) =>
            Deferred.succeed(readStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRead)),
              Effect.as(
                makePullRequestSummary({
                  ...input,
                  state: "open",
                  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS)),
                }),
              ),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* Deferred.await(readStarted);
          if (!mergeDuringRead) yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);

          yield* Ref.set(fixture.snapshots, makeSnapshot([]));
          yield* fixture.publishMerge;
          yield* Queue.take(fixture.snapshotReads);
          yield* Deferred.succeed(releaseRead, undefined);
          yield* reactor.drain;

          yield* Ref.set(fixture.snapshots, makeSnapshot([thread]));
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("rereads a branch without a pull request less often the longer its thread idles", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const recent = makeThread("recent-branch", {
        branch: "recent-feature",
        latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 30 * 60 * 1_000),
      });
      const old = makeThread("old-branch", {
        branch: "old-feature",
        latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS),
      });
      const fixture = yield* makeHarness({ snapshot: makeSnapshot([recent, old]) });
      const branches = Ref.get(fixture.branchCalls).pipe(
        Effect.map((calls) => calls.map((call) => call.branch).sort()),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        for (let minute = 1; minute <= 29; minute += 1) {
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
        }
        assert.deepStrictEqual(yield* branches, ["old-feature", "recent-feature"]);

        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        assert.deepStrictEqual(yield* branches, [
          "old-feature",
          "recent-feature",
          "recent-feature",
        ]);

        // Work ending in the thread reads its branch at once.
        yield* fixture.publishEvent({
          type: "run.background-work-cancelled",
          id: EventId.make("event:old-branch:run-ended"),
          threadId: old.id,
          occurredAt: DateTime.makeUnsafe(NOW),
          payload: { runId: RunId.make("run:old-branch"), restartCancelledBackgroundWork: [] },
        });
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        assert.deepStrictEqual(yield* branches, [
          "old-feature",
          "old-feature",
          "recent-feature",
          "recent-feature",
        ]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("a sweep looks up a few branches without a pull request, not every one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const threads = Array.from({ length: 10 }, (_, index) =>
        makeThread(`idle-${index}`, {
          branch: `idle-${index}`,
          latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - (index + 10) * 60 * 1_000),
        }),
      );
      const fixture = yield* makeHarness({ snapshot: makeSnapshot(threads) });
      const branches = Ref.get(fixture.branchCalls).pipe(
        Effect.map((calls) => calls.map((call) => call.branch).sort()),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        // The most recently active first, then the rest in turn, each once.
        assert.deepStrictEqual(yield* branches, ["idle-0", "idle-1", "idle-2", "idle-3"]);
        for (let minute = 1; minute <= 5; minute += 1) {
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
        }
        assert.deepStrictEqual(
          yield* branches,
          threads.map((thread) => thread.branch),
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("a merged branch PR that cannot settle its thread rereads no git state", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const freshReads = yield* Ref.make(0);
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([
          makeThread("worked-after-merge", {
            branch: "merged-feature",
            latestUserAuthoredMessageAt: DateTime.makeUnsafe("2026-08-28T06:00:00.000Z"),
          }),
        ]),
        settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
        branchPullRequest: (_input, lookupOptions) =>
          Ref.update(
            freshReads,
            (count) => count + (readsFreshGitState(lookupOptions) ? 1 : 0),
          ).pipe(
            Effect.as({
              ...makeBranchPullRequest("merged"),
              mergedAt: "2026-08-27T00:00:00.000Z",
            }),
          ),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;

        assert.strictEqual((yield* Ref.get(fixture.branchCalls)).length, 2);
        assert.strictEqual(yield* Ref.get(freshReads), 0);
        assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("a remembered merged branch PR settles only after fresh git state agrees", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const freshState = yield* Ref.make<"open" | "merged">("open");
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([makeThread("merged-branch", { branch: "merged-feature" })]),
        settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
        branchPullRequest: (_input, lookupOptions) =>
          readsFreshGitState(lookupOptions)
            ? Ref.get(freshState).pipe(Effect.map(makeBranchPullRequest))
            : Effect.succeed(makeBranchPullRequest("merged")),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

        yield* Ref.set(freshState, "merged");
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;

        assert.deepStrictEqual(
          (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
          [ThreadId.make("merged-branch")],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("a merge does not settle threads linked to an unrelated pull request", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const mergedThreadSettled = yield* Deferred.make<void>();
      const mergeLookupStarted = yield* Deferred.make<void>();
      const releaseMergeLookup = yield* Deferred.make<void>();
      const lookupCount = yield* Ref.make(0);
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([
          makeThread("merged-in-app", {
            latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            linkedPullRequest: {
              projectId: PROJECT_ID,
              repository: "owner/repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
            },
          }),
          makeThread("unrelated-linked", {
            latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            linkedPullRequest: {
              projectId: PROJECT_ID,
              repository: "owner/repository",
              number: 99,
              url: "https://example.test/owner/repository/pull/99",
            },
          }),
        ]),
        pullRequestSummary: (input) =>
          Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 3 ? Deferred.succeed(mergeLookupStarted, undefined) : Effect.void,
            ),
            Effect.tap((count) => (count === 3 ? Deferred.await(releaseMergeLookup) : Effect.void)),
            Effect.map(() => makePullRequestSummary({ ...input, state: "open" })),
          ),
        onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

        yield* fixture.publishMerge;
        yield* Deferred.await(mergeLookupStarted);
        yield* Deferred.await(mergedThreadSettled);
        yield* Deferred.succeed(releaseMergeLookup, undefined);
        yield* reactor.drain;

        assert.deepStrictEqual(
          (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
          [ThreadId.make("merged-in-app")],
        );
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.summaryCalls))
            .map((call) => call.number)
            .toSorted((left, right) => left - right),
          [42, 99, 99],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});

describe("ThreadSettlementServiceV2 terminals", () => {
  it.effect("keeps the terminals of a thread re-engaged before the event ran", () =>
    Effect.gen(function* () {
      const settled = appThread("reengaged-thread", "settled");
      const reengaged = appThread("reengaged-thread", "active");
      const marker = appThread("marker-thread", "settled");
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        currentThreads: [reengaged, marker],
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(settledEvent(settled));
        yield* fixture.publishEvent(settledEvent(marker));
        assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: marker.id });
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("runs the settle script in the thread's own worktree", () =>
    Effect.gen(function* () {
      const shared = appThread("shared-checkout-thread", "settled");
      const missing = appThread("removed-worktree-thread", "settled", "/worktrees/removed");
      const worktree = appThread("worktree-thread", "settled", "/worktrees/thread");
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        currentThreads: [shared, missing, worktree],
        existingWorktreePaths: ["/worktrees/thread"],
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(settledEvent(shared));
        yield* fixture.publishEvent(settledEvent(missing));
        yield* fixture.publishEvent(settledEvent(worktree));
        const run = yield* Queue.take(fixture.scriptRuns);
        assert.strictEqual(run.threadId, worktree.id);
        assert.strictEqual(run.worktreePath, "/worktrees/thread");
        assert.strictEqual(run.trigger, "settle");
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect.each([
    "own run",
    "shared thread",
    "aliased shared thread",
    "background command",
    "active peer command",
    "settled peer subagent",
  ] as const)("does not run cleanup scripts while %s still uses the worktree", (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const worktree = appThread("cleanup-owner", "settled", "/worktrees/busy");
        const sharedPeer = kind !== "own run" && kind !== "background command";
        const background = [
          "background command",
          "active peer command",
          "settled peer subagent",
        ].includes(kind);
        const peerPath = kind === "aliased shared thread" ? "/worktrees/alias" : "/worktrees/busy";
        const peer = appThread(
          "busy-peer",
          kind === "settled peer subagent" ? "settled" : "active",
          peerPath,
        );
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const active = shell({
          id: sharedPeer ? peer.id : worktree.id,
          worktreePath: sharedPeer ? peerPath : "/worktrees/busy",
          settledAt: worktree.settledAt,
          settledOverride: kind === "active peer command" ? "active" : "settled",
          status: background ? "completed" : "running",
          activeRunId: background ? null : RunId.make("active-run"),
          pendingBackgroundTasks: background
            ? [
                {
                  taskId: "preview",
                  kind: kind === "settled peer subagent" ? "subagent" : "command",
                  description: "background work",
                },
              ]
            : [],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([active]),
          currentThreads: sharedPeer ? [worktree, peer, marker] : [worktree, marker],
          existingWorktreePaths: ["/worktrees/busy", "/worktrees/marker"],
          realWorktreePaths: { "/worktrees/alias": "/worktrees/busy" },
          onRunnerRead: (path) =>
            Effect.sync(() => {
              if (kind !== "background command") assert.notInclude(path, "/worktrees/busy/");
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(worktree));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each(["root", "existing_worktree", "linked_worktree"] as const)(
    "shares canonical resources with archived active subproject peers: %s",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const linked = kind === "linked_worktree";
          const resourceRoot = linked ? "/linked" : "/repo";
          const ownerPath = kind === "root" ? null : `${resourceRoot}/apps/service`;
          const peerProjectId = ProjectId.make("sibling-project");
          const projects = [
            makeProject(PROJECT_ID, "/repo/apps/service"),
            makeProject(peerProjectId, "/repo/apps/worker"),
          ];
          const owner = appThread("subproject-owner", "settled", ownerPath);
          const activePeer = {
            ...appThread("archived-peer", "active", linked ? "/linked/apps/worker" : null),
            projectId: peerProjectId,
            archivedAt: DateTime.makeUnsafe(NOW),
          };
          const peer = {
            ...activePeer,
            settledOverride: "settled" as const,
            settledAt: owner.settledAt,
          };
          const markers = ["one", "two", "three"].map((name) =>
            appThread(`marker-${name}`, "settled", `/markers/${name}`),
          );
          const currentThreads = [owner, activePeer, ...markers];
          const pending = (thread: OrchestrationV2AppThread) =>
            shell({
              ...thread,
              status: "completed",
              activeRunId: null,
              pendingBackgroundTasks: [
                { taskId: `preview:${thread.id}`, kind: "command", description: "dev server" },
              ],
            });
          const runnerReads: string[] = [];
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([pending(owner), pending(activePeer)], projects),
            currentThreads,
            existingWorktreePaths: [
              "/repo",
              "/linked",
              "/repo/apps/service",
              "/repo/apps/worker",
              "/linked/apps/service",
              "/linked/apps/worker",
              ...markers.map((thread) => thread.worktreePath!),
            ],
            gitDirectories: ["/repo/.git"],
            gitFiles: ["/linked/.git"],
            onRunnerRead: (path) =>
              Effect.sync(() => {
                runnerReads.push(path);
              }),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            yield* fixture.publishEvent(settledEvent(owner));
            yield* fixture.publishEvent(settledEvent(markers[0]!));
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, markers[0]!.id);
            assert.notInclude(runnerReads, `${resourceRoot}/.t3/dev-runners`);
            currentThreads[1] = peer;
            yield* Ref.set(
              fixture.snapshots,
              makeSnapshot([pending(owner), pending(peer)], projects),
            );
            yield* fixture.publishEvent(settledEvent(peer));
            yield* fixture.publishEvent(settledEvent(markers[1]!));
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, markers[1]!.id);
            assert.lengthOf(
              runnerReads.filter((path) => path === `${resourceRoot}/.t3/dev-runners`),
              2,
            );
            assert.isFalse(runnerReads.some((path) => path.includes("/apps/")));
            assert.strictEqual(yield* Queue.size(fixture.scriptRuns), 0);
            yield* Ref.set(fixture.snapshots, makeSnapshot([], projects));
            yield* fixture.publishEvent({
              type: "run.background-work-cancelled",
              id: EventId.make("event:subproject-ended"),
              threadId: peer.id,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: { runId: RunId.make("preview-run"), restartCancelledBackgroundWork: [] },
            });
            yield* fixture.publishEvent(settledEvent(markers[2]!));
            if (linked) {
              const peerRun = yield* Queue.take(fixture.scriptRuns);
              const ownerRun = yield* Queue.take(fixture.scriptRuns);
              assert.strictEqual(peerRun.threadId, peer.id);
              assert.strictEqual(peerRun.worktreePath, peer.worktreePath);
              assert.strictEqual(ownerRun.threadId, owner.id);
              assert.strictEqual(ownerRun.worktreePath, ownerPath);
            }
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, markers[2]!.id);
            assert.lengthOf(
              runnerReads.filter((path) => path === `${resourceRoot}/.t3/dev-runners`),
              4,
            );
            assert.strictEqual(yield* Queue.size(fixture.scriptRuns), 0);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect.each(["worktree", "root", "existing root"] as const)(
    "retries deferred %s runners when only their peer settles; commands still block pruning",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const workspacePath = kind === "worktree" ? "/worktrees/shared" : "/workspace/project";
          const first = appThread("first-owner", "settled", kind === "root" ? null : workspacePath);
          const activePeer = appThread(
            "second-owner",
            "active",
            kind === "worktree" ? "/worktrees/alias" : null,
          );
          const second = {
            ...activePeer,
            settledOverride: "settled" as const,
            settledAt: first.settledAt,
          };
          const marker = appThread("marker-thread", "settled", "/worktrees/marker");
          const markerTwo = appThread("marker-two", "settled", "/worktrees/marker-two");
          const markerThree = appThread("marker-three", "settled", "/worktrees/marker-three");
          const currentThreads = [first, activePeer, marker, markerTwo, markerThree];
          const runnerReads: string[] = [];
          const pending = (thread: OrchestrationV2AppThread) =>
            shell({
              ...thread,
              status: "completed",
              activeRunId: null,
              pendingBackgroundTasks: [
                { taskId: `preview:${thread.id}`, kind: "command", description: "dev server" },
              ],
            });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([pending(first), pending(activePeer)]),
            currentThreads,
            existingWorktreePaths: [
              workspacePath,
              "/worktrees/alias",
              "/worktrees/marker",
              "/worktrees/marker-two",
              "/worktrees/marker-three",
            ],
            realWorktreePaths: { "/worktrees/alias": workspacePath },
            onRunnerRead: (path) =>
              Effect.sync(() => {
                runnerReads.push(path);
              }),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            yield* fixture.publishEvent(settledEvent(first));
            yield* fixture.publishEvent(settledEvent(marker));
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
            assert.deepStrictEqual(runnerReads, ["/worktrees/marker/.t3/dev-runners"]);

            currentThreads[1] = second;
            yield* Ref.set(fixture.snapshots, makeSnapshot([pending(first), pending(second)]));
            yield* fixture.publishEvent(settledEvent(second));
            yield* fixture.publishEvent(settledEvent(markerTwo));
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, markerTwo.id);
            assert.lengthOf(
              runnerReads.filter((path) => path === `${workspacePath}/.t3/dev-runners`),
              2,
            );
            assert.strictEqual(yield* Queue.size(fixture.scriptRuns), 0);

            yield* Ref.set(fixture.snapshots, makeSnapshot([]));
            yield* fixture.publishEvent({
              type: "run.background-work-cancelled",
              id: EventId.make("event:shared-commands-ended"),
              threadId: second.id,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: { runId: RunId.make("peer-run"), restartCancelledBackgroundWork: [] },
            });
            if (kind !== "worktree") {
              yield* fixture.publishEvent(settledEvent(markerThree));
              assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, markerThree.id);
              assert.strictEqual(yield* Queue.size(fixture.scriptRuns), 0);
              return;
            }
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, second.id);
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, first.id);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect.each(["completed", "interrupted", "failed", "detached"] as const)(
    "retries settled owners when only their peer ends with %s",
    (status) =>
      Effect.scoped(
        Effect.gen(function* () {
          const owner = appThread("deferred-owner", "settled", "/worktrees/deferred");
          const peer = appThread("finishing-peer", "settled", "/worktrees/alias");
          const marker = appThread("marker-one", "settled", "/worktrees/marker-one");
          const markerTwo = appThread("marker-two", "settled", "/worktrees/marker-two");
          const active = shell({
            id: peer.id,
            worktreePath: peer.worktreePath,
            settledAt: peer.settledAt,
            settledOverride: "settled",
            status: "running",
            activeRunId: RunId.make("active-run"),
          });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([active]),
            currentThreads: [owner, peer, marker, markerTwo],
            existingWorktreePaths: [
              "/worktrees/deferred",
              "/worktrees/alias",
              "/worktrees/marker-one",
              "/worktrees/marker-two",
            ],
            realWorktreePaths: { "/worktrees/alias": "/worktrees/deferred" },
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            // A fresh service must also discover owners whose settlement event was before startup.
            if (status !== "detached") yield* fixture.publishEvent(settledEvent(owner));
            yield* fixture.publishEvent(settledEvent(marker));
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
            yield* Ref.set(
              fixture.snapshots,
              makeSnapshot([shell({ ...peer, status: status === "detached" ? "idle" : status })]),
            );
            const event: OrchestrationV2DomainEvent =
              status === "detached"
                ? {
                    type: "provider-session.detached",
                    id: EventId.make("detached-for-cleanup"),
                    threadId: peer.id,
                    occurredAt: DateTime.makeUnsafe(NOW),
                    payload: {
                      providerSessionId: ProviderSessionId.make("finishing-session"),
                      detachedAt: DateTime.makeUnsafe(NOW),
                    },
                  }
                : {
                    type: "run.updated",
                    id: EventId.make("completed-for-cleanup"),
                    threadId: peer.id,
                    occurredAt: DateTime.makeUnsafe(NOW),
                    payload: {
                      id: RunId.make("active-run"),
                      threadId: peer.id,
                      ordinal: 1,
                      providerInstanceId: peer.providerInstanceId,
                      modelSelection: peer.modelSelection,
                      providerThreadId: null,
                      userMessageId: MessageId.make("message"),
                      rootNodeId: null,
                      activeAttemptId: null,
                      status,
                      requestedAt: DateTime.makeUnsafe(NOW),
                      startedAt: DateTime.makeUnsafe(NOW),
                      completedAt: DateTime.makeUnsafe(NOW),
                      checkpointId: null,
                      contextHandoffId: null,
                    },
                  };
            yield* fixture.publishEvent(event);
            yield* fixture.publishEvent(settledEvent(markerTwo));
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, peer.id);
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, owner.id);
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, markerTwo.id);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("does not scan worktrees when an ordinary active peer ends a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = appThread("deferred-owner", "settled", "/worktrees/deferred");
        const peer = appThread("active-peer", "active", "/worktrees/alias");
        const marker = appThread("marker", "settled");
        const paths: string[] = [];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [owner, peer, marker],
          existingWorktreePaths: ["/worktrees/deferred", "/worktrees/alias"],
          realWorktreePaths: { "/worktrees/alias": "/worktrees/deferred" },
          onRealPath: (path) =>
            Effect.sync(() => {
              paths.push(path);
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent({
            type: "run.background-work-cancelled",
            id: EventId.make("event:active-peer-background-ended"),
            threadId: peer.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: { runId: RunId.make("peer-run"), restartCancelledBackgroundWork: [] },
          });
          yield* fixture.publishEvent(settledEvent(marker));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: marker.id });
          assert.deepStrictEqual(paths, []);
          assert.strictEqual(yield* Queue.size(fixture.scriptRuns), 0);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each(["shells close", "runner receipts are read"] as const)(
    "skips the settle script for a thread re-engaged while its %s",
    (stage) =>
      Effect.scoped(
        Effect.gen(function* () {
          const settled = appThread("reengaging-thread", "settled", "/worktrees/reengaging");
          const marker = appThread("marker-thread", "settled", "/worktrees/marker");
          const currentThreads = [settled, marker];
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([]),
            currentThreads,
            existingWorktreePaths: ["/worktrees/reengaging", "/worktrees/marker"],
            onCloseIdle: () =>
              stage === "shells close"
                ? Effect.sync(() => {
                    currentThreads[0] = { ...settled, settledOverride: "active" };
                  })
                : Effect.void,
            onRunnerRead: () =>
              stage === "runner receipts are read"
                ? Effect.sync(() => {
                    currentThreads[0] = { ...settled, settledOverride: "active" };
                  })
                : Effect.void,
          });

          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            yield* fixture.publishEvent(settledEvent(settled));
            yield* fixture.publishEvent(settledEvent(marker));
            assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("keeps dependencies when a runner ownership receipt cannot be validated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = appThread("unverified-runner", "settled", "/worktrees/unverified");
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [owner, marker],
          existingWorktreePaths: ["/worktrees/unverified", "/worktrees/marker"],
          runnerReceiptNames: { "/worktrees/unverified/.t3/dev-runners": ["unknown.json"] },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(owner));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips the settle script for a thread re-engaged while its shells close", () =>
    Effect.gen(function* () {
      const settled = appThread("reengaging-thread", "settled", "/worktrees/reengaging");
      const marker = appThread("marker-thread", "settled", "/worktrees/marker");
      const currentThreads = [settled, marker];
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        currentThreads,
        existingWorktreePaths: ["/worktrees/reengaging", "/worktrees/marker"],
        onCloseIdle: () =>
          Effect.sync(() => {
            currentThreads[0] = { ...settled, settledOverride: "active" };
          }),
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(settledEvent(settled));
        yield* fixture.publishEvent(settledEvent(marker));
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("skips the settle script for a subagent in its parent's worktree", () =>
    Effect.gen(function* () {
      const parent = appThread("subagent-parent", "settled", "/worktrees/parent");
      const subagent = (id: string, worktreePath: string) => ({
        ...appThread(id, "settled", worktreePath),
        lineage: {
          parentThreadId: parent.id,
          relationshipToParent: "subagent" as const,
          rootThreadId: parent.id,
        },
      });
      const shared = subagent("subagent-shared", "/worktrees/parent");
      const own = subagent("subagent-own", "/worktrees/own");
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        currentThreads: [parent, shared, own],
        existingWorktreePaths: ["/worktrees/parent", "/worktrees/own"],
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        // Settling the shared child also retries its settled parent as the worktree owner.
        yield* fixture.publishEvent(settledEvent(shared));
        yield* fixture.publishEvent(settledEvent(own));
        assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: shared.id });
        assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: parent.id });
        assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: own.id });
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, parent.id);
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, own.id);
        yield* service.drain;
        assert.strictEqual(yield* Queue.size(fixture.scriptRuns), 0);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("runs the settle script once when a settlement is re-emitted", () =>
    Effect.gen(function* () {
      const repeated = appThread("repeated-thread", "settled", "/worktrees/repeated");
      const marker = appThread("marker-thread", "settled", "/worktrees/marker");
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        currentThreads: [repeated, marker],
        existingWorktreePaths: ["/worktrees/repeated", "/worktrees/marker"],
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(settledEvent(repeated));
        yield* fixture.publishEvent(settledEvent(repeated));
        yield* fixture.publishEvent(settledEvent(marker));
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, repeated.id);
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("retries the settle script on a re-emitted settlement after a failed start", () =>
    Effect.gen(function* () {
      const thread = appThread("failed-start-thread", "settled", "/worktrees/failed-start");
      const starts = yield* Ref.make(0);
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        currentThreads: [thread],
        existingWorktreePaths: ["/worktrees/failed-start"],
        onScriptRun: () =>
          Ref.updateAndGet(starts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1 ? Effect.die(new Error("terminal failed to open")) : Effect.void,
            ),
          ),
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(settledEvent(thread));
        yield* fixture.publishEvent(settledEvent(thread));
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, thread.id);
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, thread.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});

describe("isSnoozed", () => {
  const snoozed = { snoozedAt: at(-2 * DAY_MS), snoozedUntil: at(DAY_MS) };
  it("defers existing input while new questions and approvals wake the thread", () => {
    const request = {
      id: RuntimeRequestId.make("question"),
      kind: "user_input" as const,
      createdAt: snoozed.snoozedAt,
    };
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, pendingRuntimeRequest: request }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, pendingRuntimeRequest: { ...request, createdAt: at(-DAY_MS) } }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, pendingRuntimeRequest: { ...request, kind: "command" } }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, snoozedAt: null, pendingRuntimeRequest: request }),
        NOW_MS,
      ),
    ).toBe(false);
  });
  it("keeps a run requested and completed after snoozing parked until the timer", () => {
    const thread = shell({
      ...snoozed,
      status: "completed",
      latestRunRequestedAt: at(-2 * DAY_MS + 1),
      latestRunStartedAt: at(-DAY_MS - 1),
      latestRunCompletedAt: at(-DAY_MS),
    });

    expect(ThreadSettlementService.isSnoozed(thread, NOW_MS)).toBe(true);
    expect(ThreadSettlementService.isAutoSettlementCandidate(thread, NOW_MS)).toBe(false);
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        thread,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-1)) },
        nowMs: NOW_MS,
        autoSettleAfterDays: null,
        autoSettleOnMerge: true,
      }),
    ).toBeNull();
  });
});
