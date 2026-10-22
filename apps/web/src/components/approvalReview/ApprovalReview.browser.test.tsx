import { AuthSessionId, RuntimeRequestId, type ApprovalReviewAuthority } from "@t3tools/contracts";
import { canonicalReviewBundleSnapshot } from "@t3tools/client-runtime/approvalReview";
import { hashTelemetryId as sha256 } from "@t3tools/shared/telemetryId";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { usePendingApprovalSelection } from "../chat/usePendingApprovalSelection";
import type { PendingApproval } from "../../session-logic";
import { gitlabExampleBundle } from "./gitlabExample";

function externalApproval() {
  const snapshot = {
    ...gitlabExampleBundle,
    exampleOnly: false,
    target: { label: "Isolated test target", identity: "test-target" },
  };
  const bundle = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
  const authority: ApprovalReviewAuthority = {
    packageHash: bundle.hash,
    verifiedTargetId: "test-target",
    expiresAt: Date.now() + 60_000,
    state: "pending",
    requesterSubject: "test-requester",
    workerSubject: "test-worker",
    approverSessionId: AuthSessionId.make("test-human-session"),
    approverSubject: "test-human",
    implementationSource: "Synthetic test; never executed",
    action: {
      kind: "create_file_once",
      verifiedTargetId: "test-target",
      path: "/isolated-test/new.txt",
      content: "not executed",
      mode: 384,
      expectedAbsent: true,
      implementationVersion: "test-v1",
      implementationHash: "a".repeat(64),
    },
  };
  return {
    requestId: RuntimeRequestId.make("external-review"),
    requestKind: "file-change" as const,
    createdAt: "2026-10-22T00:00:00Z",
    responseCapability: "external" as const,
    detail: JSON.stringify({ approvalReview: bundle }),
    approvalReview: authority,
  };
}

function PendingQueue({
  approvals,
  onRespond,
}: {
  approvals: PendingApproval[];
  onRespond: (requestId: RuntimeRequestId, decision: string, hash?: string) => Promise<unknown>;
}) {
  const { selectedApproval: selected, selectApproval } = usePendingApprovalSelection(
    approvals,
    approvals[0] ?? null,
  );
  if (!selected) return null;
  return (
    <>
      <ComposerPendingApprovalPanel
        approval={selected}
        pendingCount={approvals.length}
        pendingIndex={approvals.indexOf(selected)}
        approvals={approvals}
        onSelectRequest={selectApproval}
      />
      <ComposerPendingApprovalActions
        approval={selected}
        requestId={selected.requestId}
        canRespond={selected.responseCapability === "external"}
        isResponding={false}
        onRespondToApproval={onRespond}
      />
    </>
  );
}

it("can review a second request while an earlier disconnected example remains pending", async () => {
  const next = externalApproval();
  const first: PendingApproval = {
    ...next,
    requestId: RuntimeRequestId.make("disconnected-first"),
    responseCapability: "not_resumable",
    approvalReview: undefined,
    detail: JSON.stringify({ approvalReview: gitlabExampleBundle }),
  };
  const onRespond = vi.fn(async () => undefined);
  await using screen = await render(
    <PendingQueue approvals={[first, next]} onRespond={onRespond} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Next pending approval" }));
  await expect.element(screen.getByText("2/2")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Review action" }));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-keyboard-local]')!;
  expect(dialog.textContent).toContain("Isolated test target");
  await act(async () =>
    [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Evidence")!
      .click(),
  );
  expect(dialog.textContent).toContain(next.requestId);
  expect(dialog.textContent).toContain(next.approvalReview.packageHash);
  await userEvent.click(screen.getByRole("button", { name: "Close review" }));
  await userEvent.click(screen.getByRole("button", { name: "Previous pending approval" }));
  await expect.element(screen.getByText("1/2")).toBeVisible();
  expect(onRespond).not.toHaveBeenCalled();
});

it("enables an exact verified external package only inside review and sends its frozen hash", async () => {
  const onRespond = vi.fn(async () => undefined);
  const approval = externalApproval();
  await using screen = await render(
    <ComposerPendingApprovalActions
      approval={approval}
      requestId={approval.requestId}
      canRespond
      isResponding={false}
      onRespondToApproval={onRespond}
    />,
  );
  expect(
    screen.container.querySelector<HTMLButtonElement>('[data-keyboard-action="approve"]')!.disabled,
  ).toBe(true);
  await act(async () =>
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Review action")!
      .click(),
  );
  const approve = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][data-keyboard-local] button'),
  ].find((button) => button.textContent === "Approve once")!;
  await expect.poll(() => approve.disabled).toBe(false);
  await act(async () => approve.click());
  expect(onRespond).toHaveBeenCalledExactlyOnceWith(
    approval.requestId,
    "accept",
    approval.approvalReview.packageHash,
  );
});

it("does not label a resolved failure result as submitted approval", async () => {
  const onRespond = vi.fn(async () => ({ _tag: "Failure" as const }));
  const approval = externalApproval();
  await using screen = await render(
    <ComposerPendingApprovalActions
      approval={approval}
      requestId={approval.requestId}
      canRespond
      isResponding={false}
      onRespondToApproval={onRespond}
    />,
  );
  await act(async () =>
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Review action")!
      .click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-keyboard-local]')!;
  const approve = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Approve once",
  )!;
  await expect.poll(() => approve.disabled).toBe(false);
  await act(async () => approve.click());
  expect(dialog.textContent).toContain("Decision rejected by the server");
  expect(dialog.textContent).not.toContain("Approval submitted.");
});

it("opens the real approval action as a viewport review and never responds to an example", async () => {
  const onRespond = vi.fn(async () => undefined);
  const approval = {
    requestId: RuntimeRequestId.make("review-example"),
    requestKind: "command" as const,
    createdAt: "2026-10-22T00:00:00Z",
    responseCapability: "live" as const,
    detail: JSON.stringify({ approvalReview: gitlabExampleBundle }),
  };
  await using screen = await render(
    <ComposerPendingApprovalActions
      approval={approval}
      requestId={approval.requestId}
      canRespond
      isResponding={false}
      onRespondToApproval={onRespond}
    />,
  );
  await act(async () => {
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Review action")!
      .click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-keyboard-local]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.getBoundingClientRect().width).toBe(window.innerWidth);
  expect(dialog.getBoundingClientRect().height).toBe(window.innerHeight);
  expect(
    [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Approve once")
      ?.disabled,
  ).toBe(true);
  expect(
    [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Reject")
      ?.disabled,
  ).toBe(true);
  expect(onRespond).not.toHaveBeenCalled();
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>('[aria-label="Next step"]')!.click(),
  );
  expect(dialog.textContent).toContain("Installation prüfen");
  await act(async () =>
    [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Source")!
      .click(),
  );
  await expect
    .poll(() => dialog.querySelector(".cm-activeLine")?.textContent)
    .toContain("check_expected_installation");
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>('[aria-label="Find in file"]')!.click(),
  );
  await expect.poll(() => dialog.querySelector(".cm-search input[name=search]")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(dialog.isConnected).toBe(true);
  expect(dialog.querySelector(".cm-search")).toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => dialog.isConnected).toBe(false);
});

it.each([
  JSON.stringify({ approvalReview: null }),
  JSON.stringify({ approvalReview: { ...gitlabExampleBundle, exampleOnly: false } }),
])(
  "blocks every accept scope for structured or malformed detail while retaining rejection",
  async (detail) => {
    const onRespond = vi.fn(async () => undefined);
    const approval = {
      requestId: RuntimeRequestId.make("review-bound"),
      requestKind: "command" as const,
      createdAt: "2026-10-22T00:00:00Z",
      responseCapability: "live" as const,
      detail,
    };
    await using screen = await render(
      <ComposerPendingApprovalActions
        approval={approval}
        requestId={approval.requestId}
        canRespond
        isResponding={false}
        onRespondToApproval={onRespond}
      />,
    );
    const approve = screen.container.querySelector<HTMLButtonElement>(
      '[data-keyboard-action="approve"]',
    )!;
    expect(approve.disabled).toBe(true);
    await act(async () => {
      approve.click();
      screen.container
        .querySelector<HTMLButtonElement>('[data-keyboard-action="decline"]')!
        .click();
    });
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(approval.requestId, "decline");
  },
);

it("submits an ordinary provider approval only once through its existing request authority", async () => {
  const onRespond = vi.fn(async () => undefined);
  const approval = {
    requestId: RuntimeRequestId.make("review-command"),
    requestKind: "command" as const,
    createdAt: "2026-10-22T00:00:00Z",
    responseCapability: "live" as const,
    detail: "Read the workspace package manifest",
  };
  await using screen = await render(
    <ComposerPendingApprovalActions
      approval={approval}
      requestId={approval.requestId}
      canRespond
      isResponding={false}
      onRespondToApproval={onRespond}
    />,
  );
  await act(async () => {
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Review action")!
      .click();
  });
  const approve = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === "Approve once",
  )!;
  await act(async () => {
    approve.click();
    approve.click();
  });
  expect(onRespond).toHaveBeenCalledExactlyOnceWith(approval.requestId, "accept");
});
