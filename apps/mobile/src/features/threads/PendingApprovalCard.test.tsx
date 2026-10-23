import {
  AuthSessionId,
  EnvironmentId,
  RuntimeRequestId,
  type ApprovalReviewAuthority,
} from "@t3tools/contracts";
import {
  canonicalReviewBundleSnapshot,
  type ReviewBundle,
} from "@t3tools/client-runtime/approvalReview";
import * as NodeCrypto from "node:crypto";
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const harness = vi.hoisted(() => ({ presses: new Map<string, () => void>() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Modal: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
    ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => {
      const label =
        React.isValidElement<{ children?: ReactNode }>(children) &&
        typeof children.props.children === "string"
          ? children.props.children
          : "details";
      if (onPress) harness.presses.set(label, onPress);
      return (
        <button disabled={disabled} onClick={onPress}>
          {children}
        </button>
      );
    },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => {
    harness.presses.set(label, onPress);
    return (
      <button onClick={onPress} disabled={disabled}>
        {label}
      </button>
    );
  },
}));
import { PendingApprovalCard } from "./PendingApprovalCard";
let root: Root | undefined;
let host: HTMLDivElement;
const requestId = RuntimeRequestId.make("mobile-approval");
const approval = {
  requestId,
  requestKind: "command" as const,
  createdAt: "2026-10-15T00:00:00.000Z",
  responseCapability: "live" as const,
  detail: "pwsh -Command {\n  Write-Output '脚本'\n}\n" + "# original\n".repeat(100),
  options: [
    { decision: "accept" as const, label: "Provider allows once" },
    { decision: "decline" as const, label: "Deny" },
    { decision: "cancel" as const, label: "Cancel request" },
  ],
};
const reviewFixture: ReviewBundle = {
  schemaVersion: 1,
  title: "Review fixture",
  packageId: "native-test-fixture",
  version: "1",
  hash: "0".repeat(64),
  files: [
    {
      path: "fixture.ps1",
      content: Array.from({ length: 110 }, (_, index) => `# fixture line ${index + 1}`).join("\n"),
      sha256: "0".repeat(64),
      language: "powershell",
    },
  ],
  steps: [
    {
      id: "inspect",
      title: "Inspect fixture source",
      description: "Test fixture only; never executed.",
      source: { path: "fixture.ps1", line: 105 },
      kind: "step",
    },
  ],
  edges: [],
  symbols: [{ name: "FixtureSymbol", path: "fixture.ps1", line: 105 }],
  target: { label: "Fixture target", rights: ["fixture right"] },
  warnings: ["Not execution evidence"],
  exampleOnly: false,
};
function reviewApproval(bundle: ReviewBundle = reviewFixture) {
  return { ...approval, detail: JSON.stringify({ approvalReview: bundle }) };
}
const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
function hostApproval() {
  const snapshot = {
    ...reviewFixture,
    files: reviewFixture.files.map((file) => ({ ...file, sha256: sha256(file.content) })),
    target: { ...reviewFixture.target, identity: "fixture-host" },
  };
  const bundle = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
  const authority: ApprovalReviewAuthority = {
    packageHash: bundle.hash,
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
      implementationHash: "a".repeat(64),
    },
    implementationSource: "fixture only",
  };
  return {
    ...reviewApproval(bundle),
    approvalReview: authority,
    responseCapability: "external" as const,
  };
}
const respond = vi.fn(
  async (_id: RuntimeRequestId, _decision: string, _hash?: string) => undefined,
);
type Props = ComponentProps<typeof PendingApprovalCard>;
function render(overrides: Partial<Props> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <PendingApprovalCard
        approval={approval}
        environmentId={EnvironmentId.make("env-a")}
        environmentLabel="RemoteHost"
        runtimeMode="auto"
        canOperateThread
        respondingApprovalId={null}
        onRespond={respond}
        {...overrides}
      />,
    ),
  );
}
function button(label: string, scope: ParentNode = host) {
  const result = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  harness.presses.clear();
  respond.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PendingApprovalCard", () => {
  it("shows the real peer, configured mode and exact expandable code without inferring sudo rights", () => {
    render();
    expect(host.textContent).toContain("RemoteHost");
    expect(host.textContent).toContain("Auto");
    expect(host.textContent).not.toContain(approval.detail);
    act(() => button("Show provider details").click());
    expect(host.textContent).toContain(approval.detail);
    expect(host.textContent).toContain("OS privilege: Not supplied");
    expect(host.textContent).toContain("Effective provider policy: Not supplied");
    expect(host.textContent).toContain("Execution unconfirmed");
  });
  it("preserves provider-supported reject/cancel choices and fallback warnings", async () => {
    render({
      approval: {
        ...approval,
        options: [
          {
            decision: "accept",
            label: "Allow once only",
            warning: "Provider cannot grant the requested session scope.",
          },
          { decision: "cancel", label: "Stop this request" },
        ],
      },
    });
    expect(host.textContent).toContain("Provider cannot grant the requested session scope.");
    expect(host.textContent).not.toContain("Allow session");
    await act(async () => button("Stop this request").click());
    expect(respond).toHaveBeenCalledWith(requestId, "cancel");
  });
  it("refuses stale/nonresumable or permission-revoked callbacks", async () => {
    render();
    const stale = harness.presses.get("Provider allows once")!;
    render({ approval: { ...approval, responseCapability: "not_resumable" } });
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Provider disconnected");
    render({ canOperateThread: false });
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
  });
  it("does not retarget an old callback or old detail disclosure after switching peers", async () => {
    render();
    const stale = harness.presses.get("Provider allows once")!;
    act(() => button("Show provider details").click());
    render({ environmentId: EnvironmentId.make("env-b"), environmentLabel: "NodeX37" });
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("NodeX37");
    expect(host.textContent).not.toContain("RemoteHost");
    expect(host.textContent).not.toContain(approval.detail);
    await act(async () => button("Deny").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
  });
  it("submits only once while a decision is in flight", async () => {
    let complete!: () => void;
    const pending = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render({ onRespond: pending });
    const press = harness.presses.get("Provider allows once")!;
    act(() => {
      press();
      press();
    });
    expect(pending).toHaveBeenCalledTimes(1);
    await act(async () => complete());
  });
  it("keeps a failed response retryable without presenting a completed action", async () => {
    respond.mockRejectedValueOnce(new Error("private error"));
    render();
    await act(async () => button("Provider allows once").click());
    expect(host.textContent).toContain("No decision was confirmed");
    expect(host.textContent).not.toContain("private error");
    await act(async () => button("Provider allows once").click());
    expect(respond).toHaveBeenCalledTimes(2);
  });
  it("opens exact fallback details fullscreen and keeps existing response authority", async () => {
    render();
    act(() => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(approval.detail);
    expect(dialog.textContent).not.toContain("Package integrity verified");
    act(() => button("Steps").click());
    expect(dialog.textContent).toContain("No step graph supplied.");
    await act(async () => harness.presses.get("Deny")!());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
    act(() => button("Close review").click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("blocks every accepting callback for bundles while preserving real decline/cancel", async () => {
    render({ approval: reviewApproval() });
    expect(button("Provider allows once").disabled).toBe(true);
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("cannot bind a decision");
    await act(async () => harness.presses.get("Cancel request")!());
    expect(respond).toHaveBeenCalledWith(requestId, "cancel");
    render({ approval: { ...reviewApproval(), options: undefined } });
    expect(button("Allow once").disabled).toBe(true);
    expect(button("Allow session").disabled).toBe(true);
    await act(async () => harness.presses.get("Allow session")!());
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => button("Decline").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
  });
  it("never calls the response channel for examples and fails closed for invalid bundles", async () => {
    render({ approval: reviewApproval({ ...reviewFixture, exampleOnly: true }) });
    for (const label of ["Provider allows once", "Deny", "Cancel request"]) {
      expect(button(label).disabled).toBe(true);
      await act(async () => harness.presses.get(label)!());
    }
    expect(respond).not.toHaveBeenCalled();
    render({ approval: { ...approval, detail: JSON.stringify({ approvalReview: {} }) } });
    expect(button("Provider allows once").disabled).toBe(true);
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    await act(async () => button("Deny").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
  });
  it("opens supplied step and symbol references without inventing edges or verification", async () => {
    const pending = reviewApproval();
    render({ approval: pending });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("# fixture line 1");
    expect(dialog.textContent).not.toContain("# fixture line 105");
    expect(dialog.textContent).not.toContain("Package integrity verified");
    expect(dialog.textContent).toContain("File SHA-256 mismatch: fixture.ps1");
    act(() => button("Steps").click());
    expect(dialog.textContent).toContain("Inspect fixture source");
    expect(dialog.textContent).not.toContain("Connections");
    act(() => button("fixture.ps1:105").click());
    expect(dialog.textContent).toContain("Lines 101–110 of 110");
    expect(dialog.textContent).toContain("# fixture line 105");
    act(() => button("Previous lines").click());
    act(() => button("FixtureSymbol · fixture.ps1:105").click());
    expect(dialog.textContent).toContain("Selected line 105");
    act(() => button("Show original request").click());
    expect(dialog.textContent).toContain(pending.detail);
  });
  it("closes review and refuses captured decisions when request text or destination changes", async () => {
    render();
    act(() => button("Open Approval Review").click());
    const stale = harness.presses.get("Provider allows once")!;
    render({ approval: reviewApproval() });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
    await act(async () => button("Open Approval Review").click());
    render({ environmentId: EnvironmentId.make("env-b"), approval: reviewApproval() });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    render({ approval: reviewApproval() });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("approves only the verified fullscreen host package and keeps raw or closed callbacks blocked", async () => {
    const pending = hostApproval();
    render({ approval: pending });
    expect(host.textContent).toContain("Review external action");
    expect(host.textContent).not.toContain("Provider disconnected");
    const rawAccept = harness.presses.get("Provider allows once")!;
    expect(button("Provider allows once").disabled).toBe(true);
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Package integrity verified");
    expect(dialog.textContent).toContain("Verified target: fixture-host");
    expect(button("Provider allows once").disabled).toBe(true);
    expect(button("Provider allows once", dialog).disabled).toBe(false);
    await act(async () => rawAccept());
    expect(respond).not.toHaveBeenCalled();
    const reviewedAccept = harness.presses.get("Provider allows once")!;
    await act(async () => button("Provider allows once", dialog).click());
    expect(respond).toHaveBeenCalledWith(requestId, "accept", pending.approvalReview.packageHash);
    act(() => button("Close review").click());
    await act(async () => reviewedAccept());
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("rechecks expiry at submission and disables open review decisions when its timer expires", async () => {
    vi.useFakeTimers();
    const pending = hostApproval();
    render({ approval: pending });
    await act(async () => button("Open Approval Review").click());
    const reviewedAccept = harness.presses.get("Provider allows once")!;
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(button("Provider allows once", dialog).disabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(button("Provider allows once", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain("no longer pending or has expired");
    await act(async () => reviewedAccept());
    expect(respond).not.toHaveBeenCalled();
  });
  it("rejects changed authority, target mismatch, unverified hashes, examples and session scope", async () => {
    const pending = hostApproval();
    render({ approval: { ...pending, options: undefined } });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(button("Allow session", dialog).disabled).toBe(true);
    await act(async () => harness.presses.get("Allow session")!());
    const staleAccept = harness.presses.get("Allow once")!;
    render({
      approval: { ...pending, approvalReview: { ...pending.approvalReview, state: "claimed" } },
    });
    await act(async () => staleAccept());
    expect(respond).not.toHaveBeenCalled();
    render({
      approval: {
        ...pending,
        approvalReview: { ...pending.approvalReview, verifiedTargetId: "other-host" },
      },
    });
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    expect(button("Provider allows once", dialog).disabled).toBe(true);
    render({ approval: { ...pending, detail: reviewApproval().detail } });
    await act(async () => button("Open Approval Review").click());
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    await act(async () => button("Close review").click());
    render({ approval: { ...pending, responseCapability: "live" } });
    await act(async () => button("Open Approval Review").click());
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
  });
  it("binds raw host rejection and cancellation to the current authority hash", async () => {
    const pending = hostApproval();
    render({ approval: pending });
    await act(async () => button("Deny").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline", pending.approvalReview.packageHash);
    await act(async () => button("Cancel request").click());
    expect(respond).toHaveBeenCalledWith(requestId, "cancel", pending.approvalReview.packageHash);
  });
  it("shows resolved server Failure without closing or claiming a confirmed host decision", async () => {
    const denied = vi.fn(async () => ({ _tag: "Failure" as const, cause: "private server cause" }));
    render({ approval: hostApproval(), onRespond: denied });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    await act(async () => button("Provider allows once", dialog).click());
    expect(denied).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.textContent).toContain("No decision was confirmed");
    expect(dialog.textContent).not.toContain("private server cause");
    expect(dialog.textContent).not.toContain("Approval submitted");
    expect(button("Provider allows once", dialog).disabled).toBe(false);
    await act(async () => button("Provider allows once", dialog).click());
    expect(denied).toHaveBeenCalledTimes(2);
  });
});
