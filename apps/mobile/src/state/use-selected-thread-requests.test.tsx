import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { syntheticOriginalOrder } from "../../../../packages/client-runtime/src/approvalReviewTestFixtures.ts";

const fixture = vi.hoisted(() => ({
  drafts: {} as Record<string, unknown>,
  uploads: {} as Record<string, unknown>,
  preparations: {} as Record<string, number>,
  preparationAtom: Symbol("preparation"),
  answers: {} as Record<string, unknown>,
  pending: null as unknown,
  status: "live",
  canOperate: true,
  commands: [] as Array<{ command: unknown; value: unknown }>,
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "drafts"
      ? fixture.drafts
      : atom === "uploads"
        ? fixture.uploads
        : atom === fixture.preparationAtom
          ? fixture.preparations
          : fixture.answers,
}));
vi.mock("./use-composer-drafts", () => ({
  composerDraftsAtom: "all-drafts",
  questionAttachmentDraftsAtom: () => "drafts",
  clearComposerDraft: vi.fn(),
}));
vi.mock("./composer-attachment-uploads", async () => ({
  ...(await import("../lib/composerAttachmentUploadQueue")),
  composerAttachmentUploadsAtom: "uploads",
}));
vi.mock("./question-attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./question-attachments")>()),
  questionAttachmentPreparationAtom: fixture.preparationAtom,
}));
vi.mock("./entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        {
          environment: {
            capabilities: {
              questionAttachments: true,
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 20_000_000 },
            },
          },
        },
      ],
    ]),
}));
vi.mock("./session", () => ({ readEnvironmentScope: () => fixture.canOperate }));
vi.mock("./threads", () => ({
  threadEnvironment: {
    respondToApproval: "approve",
    respondToUserInput: "answer",
    dismissUserInput: "dismiss",
  },
  environmentThreadDetails: {
    statusAtom: () => "currentStatus",
    pendingRequestsAtom: () => "currentPending",
  },
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "currentStatus"
        ? fixture.status
        : atom === "currentPending"
          ? fixture.pending
          : atom === "drafts" || atom === "all-drafts"
            ? fixture.drafts
            : atom === fixture.preparationAtom
              ? fixture.preparations
              : fixture.answers,
    set: (_atom: unknown, value: Record<string, unknown>) => {
      fixture.answers = value;
    },
  },
}));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (value: unknown) => {
    fixture.commands.push({ command, value });
    return { _tag: "Success" };
  },
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThreadDetailRef: { environmentId: "environment-1", threadId: "thread-1" },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadPendingRequests: () => ({
    approvals: [],
    userInputs: [
      {
        requestId: "request-1",
        createdAt: "2026-09-08T00:00:00Z",
        responseCapability: "live",
        dismissible: false,
        questions: ["first", "second"].map((id) => ({
          id,
          header: id,
          question: `Attach ${id} file`,
          options: [],
          allowCustomAnswer: true,
          multiSelect: false,
        })),
      },
    ],
  }),
}));

import {
  AuthSessionId,
  ApprovalRequestId,
  RuntimeRequestId,
  EnvironmentId,
  ThreadId,
  type ApprovalReviewAuthority,
} from "@t3tools/contracts";
import { questionAttachmentDraftKey } from "./question-attachments";
import { useSelectedThreadRequests, useThreadRequests } from "./use-selected-thread-requests";

const environmentId = EnvironmentId.make("environment-1");
const key = (question: string) =>
  questionAttachmentDraftKey(
    environmentId,
    ThreadId.make("thread-1"),
    ApprovalRequestId.make("request-1"),
    question,
  );
function submitButtonMarkup() {
  function Probe() {
    const { activePendingUserInputAnswers } = useSelectedThreadRequests();
    return <button disabled={activePendingUserInputAnswers === null}>Submit answers</button>;
  }
  return renderToStaticMarkup(<Probe />);
}
beforeEach(() => {
  fixture.preparations = {};
  fixture.answers = {};
  fixture.pending = null;
  fixture.status = "live";
  fixture.canOperate = true;
  fixture.commands = [];
  fixture.drafts = Object.fromEntries(
    ["first", "second"].map((id) => [
      key(id),
      {
        attachments: [
          {
            id,
            type: "file",
            name: `${id}.txt`,
            mimeType: "text/plain",
            sizeBytes: 4,
            fileUri: `file:///${id}.txt`,
          },
        ],
      },
    ]),
  );
  fixture.uploads = { "environment-1:first": { status: "ready" } };
});
describe("question attachment submission readiness", () => {
  it.each([
    undefined,
    { status: "uploading", progress: 0.5 },
    { status: "failed", reason: "Offline" },
  ])("keeps Submit disabled until all question uploads finish: %j", (state) => {
    if (state) fixture.uploads["environment-1:second"] = state;
    expect(submitButtonMarkup()).toContain("disabled");
    fixture.uploads["environment-1:second"] = { status: "ready" };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("ignores an upload in another environment", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.uploads["environment-2:second"] = { status: "uploading", progress: 0.5 };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("waits for attachment preparation even when uploads are ready", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.preparations[key("first")] = 1;
    expect(submitButtonMarkup()).toContain("disabled");
  });
});

describe("descendant request origin", () => {
  const origin = { environmentId, threadId: ThreadId.make("original-child") };
  const requestId = RuntimeRequestId.make("original-request");
  const question = {
    id: "scope",
    header: "Scope",
    question: "Test?",
    options: [{ label: "Fixtures", description: "No execution.", value: "  fixtures_only  " }],
    allowCustomAnswer: true,
    multiSelect: false,
  };
  const pending = {
    approvals: [
      {
        requestId,
        createdAt: "2026-10-19T00:00:00.000Z",
        responseCapability: "live" as const,
        requestKind: "command" as const,
      },
    ],
    userInputs: [
      {
        requestId,
        createdAt: "2026-10-19T00:00:00.000Z",
        responseCapability: "message" as const,
        dismissible: true,
        questions: [question],
      },
    ],
  };
  function probe() {
    const rendered = vi.fn<(value: ReturnType<typeof useThreadRequests>) => void>();
    function Probe() {
      rendered(useThreadRequests(origin, pending, { requestId, requireLive: true }));
      return null;
    }
    renderToStaticMarkup(<Probe />);
    const value = rendered.mock.lastCall?.[0];
    if (!value) throw new Error("Probe did not render");
    return value;
  }
  function prepare() {
    fixture.drafts = {};
    fixture.pending = pending;
    fixture.answers = {
      [String(environmentId) + ":" + requestId]: {
        scope: { selectedOptionValues: ["  fixtures_only  "], customAnswer: "" },
      },
    };
  }
  it("answers and declines at the original child, preserving the option value", async () => {
    prepare();
    const result = probe();
    expect(result.activePendingUserInputAnswers).toEqual({ scope: "  fixtures_only  " });
    await result.onSubmitUserInput();
    await result.onRespondToApproval(requestId, "decline");
    await result.onDismissUserInput();
    expect(fixture.commands).toEqual([
      {
        command: "answer",
        value: {
          environmentId,
          input: {
            threadId: origin.threadId,
            requestId,
            answers: { scope: "  fixtures_only  " },
          },
        },
      },
      {
        command: "approve",
        value: {
          environmentId,
          input: { threadId: origin.threadId, requestId, decision: "decline" },
        },
      },
      {
        command: "dismiss",
        value: { environmentId, input: { threadId: origin.threadId, requestId } },
      },
    ]);
  });
  it("transports the reviewed host hash at the original child and rechecks authority and permissions", async () => {
    prepare();
    const authority: ApprovalReviewAuthority = {
      packageHash: "a".repeat(64),
      verifiedTargetId: "fixture-host",
      expiresAt: Date.now() + 60_000,
      state: "pending",
      approverSessionId: AuthSessionId.make("fixture-approver-session"),
      approverSubject: "fixture-approver",
      requesterSubject: "fixture-requester",
      workerSubject: "fixture-worker",
      action: {
        kind: "create_file_once",
        verifiedTargetId: "fixture-host",
        path: "fixture.txt",
        content: "never executed",
        mode: 384,
        expectedAbsent: true,
        implementationVersion: "fixture-v1",
        implementationHash: "b".repeat(64),
      },
      implementationSource: "fixture only",
      originalOrder: syntheticOriginalOrder(Date.now() + 60_000),
      provenance: { status: "verified", reason: "trusted-original" },
    };
    const hostPending = {
      ...pending,
      approvals: [
        {
          ...pending.approvals[0]!,
          responseCapability: "external" as const,
          approvalReview: authority,
        },
      ],
    };
    fixture.pending = hostPending;
    const result = probe();
    await result.onRespondToApproval(requestId, "accept");
    await result.onRespondToApproval(requestId, "accept", "c".repeat(64));
    await result.onRespondToApproval(requestId, "acceptForSession", authority.packageHash);
    fixture.pending = {
      ...hostPending,
      approvals: [
        { ...hostPending.approvals[0]!, approvalReview: { ...authority, provenance: undefined } },
      ],
    };
    await result.onRespondToApproval(requestId, "accept", authority.packageHash);
    expect(fixture.commands).toEqual([]);
    fixture.pending = hostPending;
    await result.onRespondToApproval(requestId, "accept", authority.packageHash);
    expect(fixture.commands).toEqual([
      {
        command: "approve",
        value: {
          environmentId,
          input: {
            threadId: origin.threadId,
            requestId,
            decision: "accept",
            packageHash: authority.packageHash,
          },
        },
      },
    ]);
    fixture.pending = {
      ...hostPending,
      approvals: [
        { ...hostPending.approvals[0]!, approvalReview: { ...authority, state: "claimed" } },
      ],
    };
    await result.onRespondToApproval(requestId, "decline", authority.packageHash);
    fixture.pending = hostPending;
    fixture.canOperate = false;
    await result.onRespondToApproval(requestId, "cancel", authority.packageHash);
    expect(fixture.commands).toHaveLength(1);
    fixture.canOperate = true;
    await result.onRespondToApproval(requestId, "cancel", authority.packageHash);
    expect(fixture.commands.at(-1)).toMatchObject({
      value: {
        input: {
          threadId: origin.threadId,
          requestId,
          decision: "cancel",
          packageHash: authority.packageHash,
        },
      },
    });
  });
  it.each(["cached", "synchronizing", "live"])(
    "rejects a stale action when current state is %s",
    async (status) => {
      prepare();
      const result = probe();
      fixture.status = status;
      fixture.pending = null;
      await result.onSubmitUserInput();
      await result.onRespondToApproval(requestId, "decline");
      await result.onDismissUserInput();
      expect(fixture.commands).toEqual([]);
    },
  );
  it("rechecks origin permission and rejects an attachment uploaded elsewhere", async () => {
    prepare();
    const result = probe();
    fixture.canOperate = false;
    await result.onSubmitUserInput();
    expect(fixture.commands).toEqual([]);
    fixture.canOperate = true;
    fixture.drafts = {
      [questionAttachmentDraftKey(environmentId, origin.threadId, requestId, question.id)]: {
        attachments: [
          { id: "file", uploadedAttachmentId: "upload", uploadEnvironmentId: "environment-other" },
        ],
      },
    };
    await result.onSubmitUserInput();
    expect(fixture.commands).toEqual([]);
  });
});
