import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolvePendingThreadCreation,
  selectThreadCreationDetail,
  type PendingThreadCreation,
} from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { pendingThreadCreationShell } from "./pending-thread-creation";

const creation: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  commandId: CommandId.make("command-1"),
  text: "Fix the flaky login test",
  attachments: [
    {
      id: "draft-image",
      type: "image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 10,
      previewUri: "data:image/png;base64,AAAA",
    },
  ],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  creation: {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree",
    branch: "main",
    worktreePath: null,
  },
  createdAt: "2026-08-24T12:00:00.000Z",
};

describe("resolvePendingThreadCreation", () => {
  const threadKey = `${creation.environmentId}:${creation.threadId}`;
  const pending: PendingThreadCreation = { message: creation, outcome: null };
  const prompt = { id: creation.messageId };

  it("keeps setup visible through the prompt echo and shell cleanup until detail has a turn", () => {
    let previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous: null,
      detail: null,
    });
    expect(previous).toBe(pending);

    previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous,
      detail: { messages: [], runs: [] },
    });
    expect(previous).toBe(pending);

    previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous,
      detail: { messages: [prompt], runs: [] },
    });
    expect(previous).toBe(pending);

    previous = resolvePendingThreadCreation({
      threadKey,
      pending: null,
      previous,
      detail: { messages: [prompt], runs: [] },
    });
    expect(previous).toBe(pending);

    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: null,
        previous,
        detail: {
          messages: [{ id: "someone-else" }, prompt],
          runs: [{ status: "running" }],
        },
      }),
    ).toBeNull();
  });

  it("keeps the prompt until both the turn and its message have arrived", () => {
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending,
        previous: null,
        detail: { messages: [], runs: [{ status: "running" }] },
      }),
    ).toBe(pending);
  });

  it("preserves rejected task recovery", () => {
    const failed: PendingThreadCreation = {
      message: creation,
      outcome: { kind: "failed", message: creation, reason: "Checkout failed" },
    };
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: failed,
        previous: pending,
        detail: { messages: [], runs: [] },
      }),
    ).toBe(failed);
  });

  it("does not carry setup into another thread or invent it for existing threads", () => {
    expect(
      resolvePendingThreadCreation({
        threadKey: "another-thread",
        pending: null,
        previous: pending,
        detail: null,
      }),
    ).toBeNull();
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: null,
        previous: null,
        detail: null,
      }),
    ).toBeNull();
  });
});

describe("pendingThreadCreationShell", () => {
  it("shapes a queued creation as the thread shell the screen renders before creation", () => {
    expect(pendingThreadCreationShell(creation)).toMatchObject({
      environmentId: creation.environmentId,
      id: creation.threadId,
      projectId: creation.creation!.projectId,
      title: "Fix the flaky login test",
      modelSelection: creation.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestRun: null,
      runtime: {
        status: "preparing",
        providerInstanceId: ProviderInstanceId.make("codex"),
        updatedAt: creation.createdAt,
      },
      latestUserMessageAt: creation.createdAt,
    });
  });

  it("keeps a local task's explicit worktree path", () => {
    expect(
      pendingThreadCreationShell({
        ...creation,
        creation: {
          ...creation.creation!,
          workspaceMode: "local",
          worktreePath: "/repo/.worktrees/feature",
        },
      })?.worktreePath,
    ).toBe("/repo/.worktrees/feature");
  });

  it("returns null for a follow-up message or a creation without a model", () => {
    expect(pendingThreadCreationShell({ ...creation, creation: undefined })).toBeNull();
    expect(pendingThreadCreationShell({ ...creation, modelSelection: undefined })).toBeNull();
  });
});

describe("selectThreadCreationDetail", () => {
  const threadKey = `${creation.environmentId}:${creation.threadId}`;
  const threadRef = { environmentId: creation.environmentId, threadId: creation.threadId };

  it("withholds the detail ref until the creation is delivered", () => {
    const queued = selectThreadCreationDetail({
      threadRef,
      threadKey,
      queuedMessagesByThreadKey: { [threadKey]: [creation] },
      outcomes: {},
    });
    expect(queued).toEqual({
      pendingCreation: { message: creation, outcome: null },
      detailRef: null,
    });

    const failed = selectThreadCreationDetail({
      threadRef,
      threadKey,
      queuedMessagesByThreadKey: {},
      outcomes: { [threadKey]: { kind: "failed", message: creation, reason: "Checkout failed" } },
    });
    expect(failed.pendingCreation?.outcome?.kind).toBe("failed");
    expect(failed.detailRef).toBeNull();

    const delivered = selectThreadCreationDetail({
      threadRef,
      threadKey,
      queuedMessagesByThreadKey: {},
      outcomes: { [threadKey]: { kind: "delivered", message: creation } },
    });
    expect(delivered.pendingCreation?.outcome?.kind).toBe("delivered");
    expect(delivered.detailRef).toBe(threadRef);
  });

  it("does not hold back existing threads with only follow-ups queued", () => {
    const { creation: _creation, ...followUp } = creation;
    expect(
      selectThreadCreationDetail({
        threadRef,
        threadKey,
        queuedMessagesByThreadKey: { [threadKey]: [followUp] },
        outcomes: {},
      }),
    ).toEqual({ pendingCreation: null, detailRef: threadRef });
  });
});
