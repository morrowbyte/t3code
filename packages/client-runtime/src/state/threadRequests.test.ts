import {
  AuthSessionId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type ApprovalReviewAuthority,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  canRespondToThreadApproval,
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
  type ThreadPendingApproval,
} from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");

const reviewAuthority: ApprovalReviewAuthority = {
  packageHash: "a".repeat(64),
  verifiedTargetId: "fixture-host",
  expiresAt: 10_000,
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
};

describe("approval response authority", () => {
  const hostApproval: ThreadPendingApproval = {
    requestId,
    requestKind: "command",
    createdAt: "2026-06-20T00:00:00.000Z",
    responseCapability: "external",
    approvalReview: reviewAuthority,
  };

  it("requires external capability, current authority and exact hash for host decisions", () => {
    for (const decision of ["accept", "decline", "cancel"] as const) {
      expect(
        canRespondToThreadApproval(hostApproval, decision, reviewAuthority.packageHash, 1),
      ).toBe(true);
      expect(canRespondToThreadApproval(hostApproval, decision, undefined, 1)).toBe(false);
      expect(canRespondToThreadApproval(hostApproval, decision, "c".repeat(64), 1)).toBe(false);
      expect(
        canRespondToThreadApproval(hostApproval, decision, reviewAuthority.packageHash, 10_000),
      ).toBe(false);
    }
    expect(
      canRespondToThreadApproval(hostApproval, "acceptForSession", reviewAuthority.packageHash, 1),
    ).toBe(false);
    for (const responseCapability of ["live", "not_resumable"] as const) {
      expect(
        canRespondToThreadApproval(
          { ...hostApproval, responseCapability },
          "accept",
          reviewAuthority.packageHash,
          1,
        ),
      ).toBe(false);
    }
    for (const state of ["approved", "rejected", "claimed", "completed"] as const) {
      expect(
        canRespondToThreadApproval(
          { ...hostApproval, approvalReview: { ...reviewAuthority, state } },
          "accept",
          reviewAuthority.packageHash,
          1,
        ),
      ).toBe(false);
    }
    expect(
      canRespondToThreadApproval(
        { ...hostApproval, approvalReview: undefined },
        "accept",
        undefined,
        1,
      ),
    ).toBe(false);
  });

  it("preserves ordinary live provider decisions without a package hash", () => {
    const providerApproval = {
      ...hostApproval,
      responseCapability: "live" as const,
      approvalReview: undefined,
    };
    expect(canRespondToThreadApproval(providerApproval, "acceptForSession")).toBe(true);
    expect(canRespondToThreadApproval(providerApproval, "decline")).toBe(true);
    expect(
      canRespondToThreadApproval(providerApproval, "accept", reviewAuthority.packageHash),
    ).toBe(false);
    expect(canRespondToThreadApproval(undefined, "accept")).toBe(false);
  });
});

describe("initial user input drafts", () => {
  const questions = [
    { id: "editor", initialAnswer: "  Proposed commit\n\n" },
    { id: "empty", initialAnswer: "" },
    { id: "ordinary" },
    { id: "choices", initialAnswer: "Ignore this", allowCustomAnswer: false },
  ];

  it("seeds editable answers and preserves edits and selections on later snapshots", () => {
    const seeded = seedUserInputDraftAnswers(questions, {});
    expect(seeded).toEqual({
      editor: { customAnswer: "  Proposed commit\n\n" },
      empty: { customAnswer: "" },
    });
    const edits = {
      ...seeded,
      editor: { customAnswer: "" },
      empty: { selectedOptionValues: ["empty"], customAnswer: "" },
    };
    expect(seedUserInputDraftAnswers(questions, edits)).toEqual(edits);
    expect(
      seedUserInputDraftAnswers(questions, { editor: { customAnswer: "Edited commit" } }).editor,
    ).toEqual({ customAnswer: "Edited commit" });
    expect(seedUserInputDraftAnswers(questions, {}).editor).toEqual({
      customAnswer: "  Proposed commit\n\n",
    });
  });
});
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

it("derives host capability and authority only from the runtime request", () => {
  const request = {
    ...projection.runtimeRequests[0]!,
    kind: "command" as const,
    responseCapability: { type: "external" as const },
    approvalReview: reviewAuthority,
  };
  const item = {
    ...projection.turnItems[0]!,
    type: "approval_request" as const,
    requestKind: "command" as const,
    prompt: "Exact providerless request detail",
    approvalReview: { ...reviewAuthority, packageHash: "d".repeat(64) },
  };
  const result = derivePendingThreadRequests({ runtimeRequests: [request], turnItems: [item] });
  expect(result.approvals[0]).toMatchObject({
    responseCapability: "external",
    approvalReview: reviewAuthority,
    detail: item.prompt,
  });
  expect(
    derivePendingThreadRequests({
      runtimeRequests: [{ ...request, approvalReview: undefined }],
      turnItems: [item],
    }).approvals[0],
  ).not.toHaveProperty("approvalReview");
});

describe("pending v2 questions", () => {
  it("keeps message responses available after the originating runtime exits", () => {
    expect(projection.providerSessions).toEqual([]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it("only marks asynchronous questions as dismissible", () => {
    const live = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    expect(derivePendingThreadRequests(live).userInputs[0]?.dismissible).toBe(false);
  });
});

it("restores old text answers without mutating history or replacing unchanged rows", () => {
  const project = createQuestionHistoryProjector();
  const item = projection.turnItems[0]!;
  const row = {
    item,
    position: 0,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  };
  const rows = [row];
  const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  expect(project(pending)).toBe(rows);
  const answered = {
    ...pending,
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        status: "resolved" as const,
        answers: { next: "Continue" },
      },
    ],
  };
  const result = project(answered);
  expect(result[0]?.item).toMatchObject({
    questionAnswer: {
      answers: { next: "Continue" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    },
  });
  expect(row.item).not.toHaveProperty("questionAnswer");
  expect(project(answered)).toBe(result);
  expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
});
