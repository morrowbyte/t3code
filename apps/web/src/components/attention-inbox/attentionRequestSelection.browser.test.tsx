import { useRef } from "react";
import { EnvironmentId, NodeId, RuntimeRequestId, TurnItemId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { usePendingThreadRequests } from "../chat/usePendingThreadRequests";

function questionProjection() {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    runtimeRequests: ["q1", "q2", "approval", "auth"].map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind:
        id === "approval"
          ? ("command" as const)
          : id === "auth"
            ? ("auth_refresh" as const)
            : ("user_input" as const),
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    })),
    turnItems: ["q1", "q2"].map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId: projection.thread.id,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: projection.updatedAt,
      completedAt: projection.updatedAt,
      updatedAt: projection.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      questions: [{ id: "answer", header: id, question: `Answer ${id}`, options: [] }],
    })),
  };
}

function Probe({
  projection,
  target,
  environmentId,
}: {
  projection: ReturnType<typeof questionProjection>;
  target: string | null;
  environmentId: EnvironmentId;
}) {
  const state = usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    targetRequestId: target,
    serverProjection: projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: () => {},
    promptRef: useRef(""),
    composerRef: useRef(null),
    setThreadError: () => {},
  });
  return (
    <>
      <output aria-label="Active question">
        {state.activePendingUserInput?.requestId ?? "none"}
      </output>
      <output aria-label="Active approval">
        {state.activePendingApproval?.requestId ?? "none"}
      </output>
      <output aria-label="Remaining requests">
        {state.pendingUserInputs.length + state.pendingApprovals.length}
      </output>
      <output aria-label="Draft answer">
        {state.activePendingDraftAnswers.answer?.customAnswer ?? "empty"}
      </output>
      <button
        type="button"
        onClick={() => state.onChangeActivePendingUserInputCustomAnswer("answer", "Q2 draft")}
      >
        Write answer
      </button>
    </>
  );
}

it("opens exactly Q2, retains its draft across reconnect, and requires deliberate navigation after resolution", async () => {
  const projection = questionProjection();
  const environmentId = EnvironmentId.make("attention-selection");
  const view = (target: string | null, source = projection, environment = environmentId) => (
    <Probe projection={source} target={target} environmentId={environment} />
  );
  await using screen = await render(view("q2"));
  await expect.element(screen.getByLabelText("Active question")).toHaveTextContent("q2");
  await expect.element(screen.getByLabelText("Active approval")).toHaveTextContent("none");
  await expect.element(screen.getByLabelText("Remaining requests")).toHaveTextContent("3");
  await screen.getByRole("button", { name: "Write answer" }).click();
  await screen.rerender(view("q1"));
  await expect.element(screen.getByLabelText("Draft answer")).toHaveTextContent("empty");
  await screen.rerender(view("q2", projection, EnvironmentId.make("attention-other")));
  await expect.element(screen.getByLabelText("Draft answer")).toHaveTextContent("empty");
  await screen.rerender(null);
  await screen.rerender(view("q2"));
  await expect.element(screen.getByLabelText("Draft answer")).toHaveTextContent("Q2 draft");
  const resolved = {
    ...projection,
    runtimeRequests: projection.runtimeRequests.filter((request) => request.id !== "q2"),
  };
  await screen.rerender(view("q2", resolved));
  await expect.element(screen.getByLabelText("Active question")).toHaveTextContent("none");
  await expect.element(screen.getByLabelText("Active approval")).toHaveTextContent("none");
  await screen.rerender(view(null, resolved));
  await expect.element(screen.getByLabelText("Active question")).toHaveTextContent("q1");
  await screen.rerender(view("approval"));
  await expect.element(screen.getByLabelText("Active question")).toHaveTextContent("none");
  await expect.element(screen.getByLabelText("Active approval")).toHaveTextContent("approval");
  await screen.rerender(view("auth"));
  await expect.element(screen.getByLabelText("Active question")).toHaveTextContent("none");
  await expect.element(screen.getByLabelText("Active approval")).toHaveTextContent("none");
});
